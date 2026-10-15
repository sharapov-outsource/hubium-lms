import { describe, expect, it } from 'vitest';
import { buildFrameworkCsv, parseFrameworkCsv } from './csv.ts';
import {
  checkPointsConfig,
  checkScaleConfig,
  competencyRuleMet,
  isProficient,
  taxonomyAt,
} from './model.ts';

describe('competency scales and rules', () => {
  it('checks a scale configuration against its scale', () => {
    expect(checkScaleConfig({ default: 2, proficient: [3, 2, 2] }, 3)).toEqual({
      default: 2,
      proficient: [2, 3],
    });
    expect(() => checkScaleConfig({ default: 4, proficient: [4] }, 3)).toThrow(/not on the scale/);
    expect(() => checkScaleConfig({ default: 1, proficient: [2] }, 3)).toThrow(/proficient/);
    expect(isProficient({ default: 2, proficient: [2, 3] }, 3)).toBe(true);
    expect(isProficient({ default: 2, proficient: [2, 3] }, 1)).toBe(false);
    expect(isProficient({ default: 2, proficient: [2, 3] }, null)).toBe(false);
  });

  it('names levels by their taxonomy, the last one going on below', () => {
    expect(taxonomyAt(['domain', 'skill'], 0)).toBe('domain');
    expect(taxonomyAt(['domain', 'skill'], 3)).toBe('skill');
    expect(taxonomyAt(['nonsense'], 0)).toBe('competency');
  });

  it('meets ALL with every child proficient, POINTS with enough points and the required ones', () => {
    const kids = ['a', 'b', 'c'];
    expect(competencyRuleMet('ALL', null, kids, new Set(['a', 'b']))).toBe(false);
    expect(competencyRuleMet('ALL', null, kids, new Set(kids))).toBe(true);
    expect(competencyRuleMet('ALL', null, [], new Set())).toBe(false);
    const cfg = checkPointsConfig(
      {
        points: 3,
        children: [
          { id: 'a', points: 2, required: true },
          { id: 'b', points: 1 },
          { id: 'c', points: 2 },
        ],
      },
      kids,
    );
    expect(competencyRuleMet('POINTS', cfg, kids, new Set(['b', 'c']))).toBe(false);
    expect(competencyRuleMet('POINTS', cfg, kids, new Set(['a', 'b']))).toBe(true);
    expect(competencyRuleMet('POINTS', cfg, kids, new Set(['a']))).toBe(false);
    expect(() =>
      checkPointsConfig({ points: 9, children: [{ id: 'a', points: 1 }] }, kids),
    ).toThrow(/cannot add up/);
    expect(() =>
      checkPointsConfig({ points: 1, children: [{ id: 'x', points: 1 }] }, kids),
    ).toThrow(/not a child/);
  });
});

describe('competency framework CSV (Moodle)', () => {
  it('reads what it writes', () => {
    const csv = buildFrameworkCsv(
      {
        idNumber: 'DIG',
        shortName: 'Цифровые навыки',
        description: 'Рамка, "с кавычками"',
        scaleId: 's1',
        scaleItems: ['Не освоено', 'Освоено'],
        scaleConfig: { default: 2, proficient: [2] },
        taxonomies: ['domain', 'skill'],
      },
      [
        {
          parentIdNumber: null,
          idNumber: 'DIG.1',
          shortName: 'Данные',
          description: '',
          scaleId: null,
          scaleItems: null,
          scaleConfig: null,
          ruleType: 'POINTS',
          ruleOutcome: 'COMPLETE',
          ruleConfig: { points: 1, children: [{ id: 'x2', points: 1, required: false }] },
          related: ['DIG.2'],
          exportId: 'x1',
        },
        {
          parentIdNumber: 'DIG.1',
          idNumber: 'DIG.1.1',
          shortName: 'Таблицы',
          description: 'Строки, столбцы',
          scaleId: null,
          scaleItems: null,
          scaleConfig: null,
          ruleType: null,
          ruleOutcome: 'NONE',
          ruleConfig: null,
          related: [],
          exportId: 'x2',
        },
        {
          parentIdNumber: null,
          idNumber: 'DIG.2',
          shortName: 'Безопасность',
          description: '',
          scaleId: 's2',
          scaleItems: ['Нет', 'Частично', 'Да'],
          scaleConfig: { default: 3, proficient: [2, 3] },
          ruleType: null,
          ruleOutcome: 'NONE',
          ruleConfig: null,
          related: ['DIG.1'],
          exportId: 'x3',
        },
      ],
    );
    const { framework, competencies } = parseFrameworkCsv(csv);
    expect(framework).toEqual({
      idNumber: 'DIG',
      shortName: 'Цифровые навыки',
      description: 'Рамка, "с кавычками"',
      scaleItems: ['Не освоено', 'Освоено'],
      scaleConfig: { default: 2, proficient: [2] },
      taxonomies: ['domain', 'skill'],
    });
    expect(competencies.map((c) => [c.idNumber, c.parentIdNumber])).toEqual([
      ['DIG.1', null],
      ['DIG.1.1', 'DIG.1'],
      ['DIG.2', null],
    ]);
    expect(competencies[0]).toMatchObject({
      ruleType: 'POINTS',
      ruleOutcome: 'COMPLETE',
      ruleConfig: { points: 1, children: [{ id: 'x2', points: 1, required: false }] },
      related: ['DIG.2'],
      exportId: 'x1',
    });
    expect(competencies[2]).toMatchObject({
      scaleItems: ['Нет', 'Частично', 'Да'],
      scaleConfig: { default: 3, proficient: [2, 3] },
    });
  });

  it('reads a file exported by Moodle, HTML descriptions included', () => {
    const moodle = [
      '"Parent ID number","ID number","Short name","Description","Description format","Scale values","Scale configuration","Rule type (optional)","Rule outcome (optional)","Rule config (optional)","Cross-referenced competency ID numbers","Exported ID (optional)","Is framework","Taxonomy"',
      '"","FW1","Framework","<p>A <b>framework</b></p>","1","Not yet competent,Competent","[{""scaleid"":""2""},{""id"":1,""scaledefault"":0,""proficient"":0},{""id"":2,""scaledefault"":1,""proficient"":1}]","","","","","","1","competency,competency,competency,competency"',
      '"","C1","Parent","","1","","","\\core_competency\\competency_rule_all","3","","","10","0",""',
      '"C1","C1.1","Child","<p>child</p>","1","","","","","","","11","0",""',
    ].join('\n');
    const { framework, competencies } = parseFrameworkCsv(moodle);
    expect(framework).toMatchObject({
      idNumber: 'FW1',
      description: 'A framework',
      scaleConfig: { default: 2, proficient: [2] },
    });
    expect(competencies[0]).toMatchObject({ ruleType: 'ALL', ruleOutcome: 'RECOMMEND' });
    expect(competencies[1]).toMatchObject({ parentIdNumber: 'C1', description: 'child' });
  });

  it('says what is wrong with a file', () => {
    expect(() => parseFrameworkCsv('a,b\n')).toThrow(/no framework/);
    const head = buildFrameworkCsv(
      {
        idNumber: 'F',
        shortName: 'F',
        description: '',
        scaleId: 's',
        scaleItems: ['a', 'b'],
        scaleConfig: { default: 2, proficient: [2] },
        taxonomies: ['competency'],
      },
      [],
    );
    expect(() =>
      parseFrameworkCsv(`${head}"X","C","C","","2","","","","","","","","0",""\r\n`),
    ).toThrow(/parent X/);
  });
});
