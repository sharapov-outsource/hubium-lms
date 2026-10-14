import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';

// A small Moodle 4.5 course backup (.mbz) with the structure Moodle writes: sections,
// a page with an embedded image, a quiz using question bank entries and a random slot,
// an assignment, a URL, a file resource, Q&A and news forums and an unsupported wiki.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const hash = (b: Buffer) => createHash('sha1').update(b).digest('hex');

const activity = (id: number, mod: string, title: string, section: number) =>
  `<activity><moduleid>${id}</moduleid><sectionid>${section}</sectionid><modulename>${mod}</modulename><title>${title}</title><directory>activities/${mod}_${id}</directory></activity>`;

const moduleXml = (id: number, mod: string, section: number, visible = 1) =>
  `<?xml version="1.0" encoding="UTF-8"?><module id="${id}" version="2024100700"><modulename>${mod}</modulename><sectionid>${section}</sectionid><sectionnumber>0</sectionnumber><idnumber></idnumber><added>1700000000</added><visible>${visible}</visible><showdescription>0</showdescription></module>`;

const wrap = (id: number, mod: string, ctx: number, inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><activity id="${id}" moduleid="${id}" modulename="${mod}" contextid="${ctx}"><${mod} id="${id}">${inner}</${mod}></activity>`;

export async function mbzFixture(): Promise<Buffer> {
  const files: Record<string, string | Buffer> = {
    'moodle_backup.xml': `<?xml version="1.0" encoding="UTF-8"?>
<moodle_backup><information>
  <name>backup-moodle2-course-2-py.mbz</name><moodle_version>2024100700</moodle_version><moodle_release>4.5 (Build: 20241007)</moodle_release>
  <original_course_fullname>Python из Moodle</original_course_fullname><original_course_shortname>MOODLE-PY</original_course_shortname>
  <contents>
    <activities>
      ${activity(11, 'page', 'Введение', 1)}
      ${activity(14, 'url', 'Документация', 1)}
      ${activity(12, 'quiz', 'Тест', 2)}
      ${activity(13, 'assign', 'Задание', 2)}
      ${activity(15, 'resource', 'Методичка', 2)}
      ${activity(16, 'forum', 'Вопросы', 2)}
      ${activity(17, 'forum', 'Новости', 2)}
      ${activity(18, 'wiki', 'Вики', 2)}
    </activities>
    <sections>
      <section><sectionid>1</sectionid><title>0</title><directory>sections/section_1</directory></section>
      <section><sectionid>2</sectionid><title>Тема 1</title><directory>sections/section_2</directory></section>
    </sections>
    <course><courseid>2</courseid><title>MOODLE-PY</title><directory>course</directory></course>
  </contents>
</information></moodle_backup>`,
    'course/course.xml': `<?xml version="1.0" encoding="UTF-8"?><course id="2" contextid="20"><shortname>MOODLE-PY</shortname><fullname>Python из Moodle</fullname><summary>&lt;p&gt;Курс &lt;img src="@@PLUGINFILE@@/logo.png"&gt;&lt;/p&gt;</summary><format>topics</format><startdate>1735689600</startdate><enddate>0</enddate></course>`,
    'sections/section_1/section.xml': `<?xml version="1.0" encoding="UTF-8"?><section id="1"><number>0</number><name>$@NULL@$</name><summary></summary><sequence>11,14</sequence><visible>1</visible></section>`,
    'sections/section_2/section.xml': `<?xml version="1.0" encoding="UTF-8"?><section id="2"><number>1</number><name>Тема 1</name><summary>&lt;p&gt;Первая тема&lt;/p&gt;</summary><sequence>12,13,15,16,17,18</sequence><visible>1</visible></section>`,

    'activities/page_11/module.xml': moduleXml(11, 'page', 1),
    'activities/page_11/page.xml': wrap(
      11,
      'page',
      31,
      '<name>Введение</name><intro></intro><content><![CDATA[<p>Привет <img src="@@PLUGINFILE@@/diagram.png" alt="d"></p>]]></content><contentformat>1</contentformat>',
    ),
    'activities/url_14/module.xml': moduleXml(14, 'url', 1),
    'activities/url_14/url.xml': wrap(
      14,
      'url',
      34,
      '<name>Документация</name><intro></intro><externalurl>https://docs.python.org/3/</externalurl>',
    ),
    'activities/quiz_12/module.xml': moduleXml(12, 'quiz', 2),
    'activities/quiz_12/quiz.xml': wrap(
      12,
      'quiz',
      32,
      `<name>Тест</name><intro>&lt;p&gt;Проверка&lt;/p&gt;</intro><timeopen>0</timeopen><timeclose>0</timeclose><timelimit>900</timelimit><attempts>2</attempts><grademethod>1</grademethod><grade>10.00000</grade><questionsperpage>2</questionsperpage><password>Секрет-1</password><subnet>192.168.1.0/24, office</subnet><delay1>600</delay1><delay2>3601</delay2><navmethod>seq</navmethod><preferredbehaviour>adaptive</preferredbehaviour><reviewspecificfeedback>69888</reviewspecificfeedback><reviewrightanswer>4352</reviewrightanswer>
      <question_instances>
        <question_instance id="1"><slot>1</slot><page>1</page><maxmark>1.0000000</maxmark><question_reference id="1"><usingcontextid>32</usingcontextid><component>mod_quiz</component><questionarea>slot</questionarea><questionbankentryid>5</questionbankentryid><version>$@NULL@$</version></question_reference></question_instance>
        <question_instance id="2"><slot>2</slot><page>1</page><maxmark>2.0000000</maxmark><question_reference id="2"><questionbankentryid>6</questionbankentryid></question_reference></question_instance>
        <question_instance id="3"><slot>3</slot><page>2</page><maxmark>1.0000000</maxmark><question_set_reference id="3"><filtercondition>{"questioncategoryid":"2","includingsubcategories":"0"}</filtercondition></question_set_reference></question_instance>
      </question_instances>`,
    ),
    'activities/assign_13/module.xml': moduleXml(13, 'assign', 2, 0),
    'activities/assign_13/assign.xml': wrap(
      13,
      'assign',
      33,
      '<name>Задание</name><intro>&lt;p&gt;Сдайте код&lt;/p&gt;</intro><duedate>1767225600</duedate><allowsubmissionsfromdate>0</allowsubmissionsfromdate><cutoffdate>0</cutoffdate><grade>20</grade><submissiondrafts>1</submissiondrafts>',
    ),
    'activities/resource_15/module.xml': moduleXml(15, 'resource', 2),
    'activities/resource_15/resource.xml': wrap(
      15,
      'resource',
      35,
      '<name>Методичка</name><intro></intro>',
    ),
    'activities/forum_16/module.xml': moduleXml(16, 'forum', 2),
    'activities/forum_16/forum.xml': wrap(
      16,
      'forum',
      36,
      '<type>qanda</type><name>Вопросы</name><intro></intro>',
    ),
    'activities/forum_17/module.xml': moduleXml(17, 'forum', 2),
    'activities/forum_17/forum.xml': wrap(
      17,
      'forum',
      37,
      '<type>news</type><name>Новости</name><intro></intro>',
    ),
    'activities/wiki_18/module.xml': moduleXml(18, 'wiki', 2),
    'activities/wiki_18/wiki.xml': wrap(
      18,
      'wiki',
      38,
      '<name>Вики</name><intro>&lt;p&gt;Общая вики&lt;/p&gt;</intro>',
    ),

    'questions.xml': `<?xml version="1.0" encoding="UTF-8"?>
<question_categories>
  <question_category id="1"><name>top</name><contextid>20</contextid><contextlevel>50</contextlevel><parent>0</parent><question_bank_entries></question_bank_entries></question_category>
  <question_category id="2"><name>По умолчанию для курса</name><contextid>20</contextid><contextlevel>50</contextlevel><info>Основные вопросы</info><parent>1</parent>
    <question_bank_entries>
      <question_bank_entry id="5"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="5"><version>1</version><status>ready</status><questions>
        <question id="50"><parent>0</parent><name>Тип 3.14</name><questiontext>&lt;p&gt;Какой тип у 3.14?&lt;/p&gt;</questiontext><generalfeedback></generalfeedback><defaultmark>1.0000000</defaultmark><penalty>0.3333333</penalty><qtype>multichoice</qtype>
          <plugin_qtype_multichoice_question><answers>
            <answer id="501"><answertext>float</answertext><answerformat>1</answerformat><fraction>1.0000000</fraction><feedback>Да</feedback></answer>
            <answer id="502"><answertext>int</answertext><answerformat>1</answerformat><fraction>0.0000000</fraction><feedback></feedback></answer>
          </answers><multichoice id="1"><single>1</single><shuffleanswers>1</shuffleanswers></multichoice></plugin_qtype_multichoice_question>
          <question_hints><question_hint id="1"><hint>&lt;p&gt;Посмотрите на точку&lt;/p&gt;</hint><hintformat>1</hintformat><shownumcorrect>0</shownumcorrect><clearwrong>1</clearwrong><options>$@NULL@$</options></question_hint></question_hints>
        </question>
      </questions></question_versions></question_version></question_bank_entry>
      <question_bank_entry id="6"><questioncategoryid>2</questioncategoryid><question_version>
        <question_versions id="6"><version>1</version><questions><question id="60"><name>Старая версия</name><questiontext>old</questiontext><defaultmark>1</defaultmark><qtype>truefalse</qtype>
          <plugin_qtype_truefalse_question><answers><answer id="601"><answertext>True</answertext><fraction>0</fraction></answer><answer id="602"><answertext>False</answertext><fraction>1</fraction></answer></answers><truefalse><trueanswer>601</trueanswer><falseanswer>602</falseanswer></truefalse></plugin_qtype_truefalse_question></question></questions></question_versions>
        <question_versions id="7"><version>2</version><questions><question id="61"><name>Комментарий</name><questiontext>Комментарий начинается с #</questiontext><defaultmark>1</defaultmark><qtype>truefalse</qtype>
          <plugin_qtype_truefalse_question><answers><answer id="611"><answertext>True</answertext><fraction>1</fraction><feedback>Верно</feedback></answer><answer id="612"><answertext>False</answertext><fraction>0</fraction></answer></answers><truefalse><trueanswer>611</trueanswer><falseanswer>612</falseanswer></truefalse></plugin_qtype_truefalse_question></question></questions></question_versions>
      </question_version></question_bank_entry>
      <question_bank_entry id="7"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="8"><version>1</version><questions>
        <question id="70"><name>Формула</name><questiontext>x+y</questiontext><defaultmark>1</defaultmark><qtype>calculated</qtype></question>
      </questions></question_versions></question_version></question_bank_entry>
      <question_bank_entry id="8"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="9"><version>1</version><questions>
        <question id="80"><name>Порядок</name><questiontext>&lt;p&gt;Этапы&lt;/p&gt;</questiontext><defaultmark>1</defaultmark><penalty>0.3333333</penalty><qtype>ordering</qtype>
          <plugin_qtype_ordering_question><answers>
            <answer id="802"><answertext>&lt;p&gt;Выполнить&lt;/p&gt;</answertext><answerformat>1</answerformat><fraction>2.0000000</fraction><feedback></feedback></answer>
            <answer id="801"><answertext>&lt;p&gt;Написать&lt;/p&gt;</answertext><answerformat>1</answerformat><fraction>1.0000000</fraction><feedback></feedback></answer>
            <answer id="803"><answertext>&lt;p&gt;Проверить&lt;/p&gt;</answertext><answerformat>1</answerformat><fraction>3.0000000</fraction><feedback></feedback></answer>
          </answers><ordering id="1"><layouttype>1</layouttype><selecttype>0</selecttype><selectcount>3</selectcount><gradingtype>5</gradingtype><showgrading>0</showgrading><numberingstyle>abc</numberingstyle><correctfeedback>Верно</correctfeedback><partiallycorrectfeedback></partiallycorrectfeedback><incorrectfeedback></incorrectfeedback><shownumcorrect>1</shownumcorrect></ordering></plugin_qtype_ordering_question>
        </question>
      </questions></question_versions></question_version></question_bank_entry>
      <question_bank_entry id="9"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="10"><version>1</version><questions>
        <question id="90"><name>Перетаскивание</name><questiontext>&lt;p&gt;[[1]] — список, [[2]] — кортеж&lt;/p&gt;</questiontext><defaultmark>1</defaultmark><qtype>ddwtos</qtype>
          <plugin_qtype_ddwtos_question><answers>
            <answer id="901"><answertext>list</answertext><answerformat>0</answerformat><fraction>0</fraction><feedback>O:8:"stdClass":2:{s:9:"draggroup";s:1:"1";s:8:"infinite";i:0;}</feedback></answer>
            <answer id="902"><answertext>tuple</answertext><answerformat>0</answerformat><fraction>0</fraction><feedback>O:8:"stdClass":2:{s:9:"draggroup";s:1:"2";s:8:"infinite";i:1;}</feedback></answer>
          </answers><ddwtos id="1"><shuffleanswers>0</shuffleanswers><correctfeedback></correctfeedback><partiallycorrectfeedback></partiallycorrectfeedback><incorrectfeedback></incorrectfeedback></ddwtos></plugin_qtype_ddwtos_question>
        </question>
      </questions></question_versions></question_version></question_bank_entry>
    </question_bank_entries>
  </question_category>
</question_categories>`,
  };
  const blobs: {
    ctx: number;
    component: string;
    area: string;
    name: string;
    mime: string;
    data: Buffer;
  }[] = [
    {
      ctx: 20,
      component: 'course',
      area: 'summary',
      name: 'logo.png',
      mime: 'image/png',
      data: PNG,
    },
    {
      ctx: 31,
      component: 'mod_page',
      area: 'content',
      name: 'diagram.png',
      mime: 'image/png',
      data: PNG,
    },
    {
      ctx: 35,
      component: 'mod_resource',
      area: 'content',
      name: 'guide.pdf',
      mime: 'application/pdf',
      data: PDF,
    },
  ];
  files['files.xml'] = `<?xml version="1.0" encoding="UTF-8"?><files>${blobs
    .map(
      (b, i) =>
        `<file id="${i + 1}"><contenthash>${hash(b.data)}</contenthash><contextid>${b.ctx}</contextid><component>${b.component}</component><filearea>${b.area}</filearea><itemid>0</itemid><filepath>/</filepath><filename>${b.name}</filename><mimetype>${b.mime}</mimetype></file>`,
    )
    .join(
      '',
    )}<file id="9"><contenthash>da39a3ee5e6b4b0d3255bfef95601890afd80709</contenthash><contextid>31</contextid><component>mod_page</component><filearea>content</filearea><itemid>0</itemid><filepath>/</filepath><filename>.</filename></file></files>`;
  for (const b of blobs) files[`files/${hash(b.data).slice(0, 2)}/${hash(b.data)}`] = b.data;

  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: unknown) => chunks.push(c as Buffer));
  const done = new Promise<void>((r) => pack.on('end', () => r()));
  for (const [name, body] of Object.entries(files))
    pack.entry({ name }, typeof body === 'string' ? Buffer.from(body) : body);
  pack.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}
