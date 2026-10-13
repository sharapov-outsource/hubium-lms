import { beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createCategory, updateCategory } from './categories.ts';
import { createCourse, searchCatalog, searchTerms } from './courses.ts';

describe('catalog search', () => {
  const t = useTestDb();
  let science: string;

  beforeAll(async () => {
    const sys = await ctxFor(t.db, 'system');
    const it = (await createCategory.run(sys, { name: 'ИТ-направление' })).id;
    science = (await createCategory.run(sys, { name: 'Естественные науки' })).id;
    for (const [categoryId, fullName, shortName, summary] of [
      [it, 'Программирование на Python', 'PY-101', '<p>Основы языка и <b>практика</b></p>'],
      [it, 'Алгебра для школьников', 'ALG-7', '<p>Уравнения</p>'],
      [science, 'Математика', 'MATH-1', '<p>Пределы и ряды</p>'],
      [it, 'Учёт и отчётность', 'ACC-1', ''],
      [it, 'Übungen zur Programmierung', 'DE-1', '<p>Grundlagen</p>'],
      [it, 'Histoire de l’art', 'FR-1', '<p>Les élèves découvrent la peinture</p>'],
    ] as const)
      await createCourse.run(sys, { categoryId, fullName, shortName, summary, sections: 1 });
  });

  const names = async (q: string) =>
    (await searchCatalog(await ctxFor(t.db, 'system'), { q })).items.map((c) => c.fullName);

  it('normalises query words', () => {
    expect(searchTerms('Учёт, «отчёты» & C++!')).toEqual(['учет', 'отчеты', 'c']);
  });

  it('matches word forms, prefixes, typos, letters ё/е and the summary', async () => {
    expect(await names('программированию')).toEqual(['Программирование на Python']);
    expect(await names('алг')).toEqual(['Алгебра для школьников']);
    expect(await names('матиматика')).toEqual(['Математика']);
    expect(await names('учет')).toEqual(['Учёт и отчётность']);
    expect(await names('практика')).toEqual(['Программирование на Python']);
    expect(await names('ряды пределы')).toEqual(['Математика']);
    expect(await names('py-101')).toEqual(['Программирование на Python']);
  });

  it('searches in every installed language and ignores accents', async () => {
    expect(await names('ubungen')).toEqual(['Übungen zur Programmierung']);
    expect(await names('programmierungen')).toEqual(['Übungen zur Programmierung']);
    expect(await names('eleves')).toEqual(['Histoire de l’art']);
    expect(await names('peintures')).toEqual(['Histoire de l’art']);
  });

  it('finds courses by their category, also after it is renamed', async () => {
    expect(await names('естественные')).toEqual(['Математика']);
    const admin = await ctxFor(t.db, 'admin@test.local');
    await updateCategory.run(admin, { id: science, name: 'Точные науки' });
    expect(await names('точные')).toEqual(['Математика']);
    expect(await names('естественные')).toEqual([]);
  });
});
