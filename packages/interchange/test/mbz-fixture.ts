import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';

// A small Moodle 4.5 course backup (.mbz) with the structure Moodle writes: sections,
// a page with an embedded image, a quiz using question bank entries and a random slot,
// an assignment (teams, marking workflow, blind marking, a rubric, a group's dates), a
// URL, a file resource, Q&A (rated) and news forums, a book with an image in a chapter, a choice, a feedback,
// a rated glossary with an entry, a lesson of four pages, a wiki with a page, a database with
// fields, templates and an entry, a workshop with a rubric and a submission, an H5P
// activity with an attempt, and an unsupported content package; groups and a
// grouping, a scale, and a gradebook with a category, a manual item and a formula.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const hash = (b: Buffer) => createHash('sha1').update(b).digest('hex');

const activity = (id: number, mod: string, title: string, section: number) =>
  `<activity><moduleid>${id}</moduleid><sectionid>${section}</sectionid><modulename>${mod}</modulename><title>${title}</title><directory>activities/${mod}_${id}</directory></activity>`;

const moduleXml = (
  id: number,
  mod: string,
  section: number,
  visible = 1,
  extra: { idnumber?: string; groupmode?: number; groupingid?: number } = {},
) =>
  `<?xml version="1.0" encoding="UTF-8"?><module id="${id}" version="2024100700"><modulename>${mod}</modulename><sectionid>${section}</sectionid><sectionnumber>0</sectionnumber><idnumber>${extra.idnumber ?? ''}</idnumber><added>1700000000</added><visible>${visible}</visible><showdescription>0</showdescription><groupmode>${extra.groupmode ?? 0}</groupmode><groupingid>${extra.groupingid ?? 0}</groupingid></module>`;

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
      ${activity(19, 'book', 'Учебник', 2)}
      ${activity(20, 'choice', 'Тема проекта', 2)}
      ${activity(21, 'feedback', 'Отзыв', 2)}
      ${activity(22, 'glossary', 'Словарь', 2)}
      ${activity(23, 'lesson', 'Маршрут', 2)}
      ${activity(24, 'imscp', 'Пакет', 2)}
      ${activity(25, 'data', 'Каталог', 2)}
      ${activity(26, 'workshop', 'Рецензии', 2)}
      ${activity(27, 'h5pactivity', 'Интерактив', 2)}
    </activities>
    <sections>
      <section><sectionid>1</sectionid><title>0</title><directory>sections/section_1</directory></section>
      <section><sectionid>2</sectionid><title>Тема 1</title><directory>sections/section_2</directory></section>
    </sections>
    <course><courseid>2</courseid><title>MOODLE-PY</title><directory>course</directory></course>
  </contents>
</information></moodle_backup>`,
    'course/course.xml': `<?xml version="1.0" encoding="UTF-8"?><course id="2" contextid="20"><shortname>MOODLE-PY</shortname><fullname>Python из Moodle</fullname><summary>&lt;p&gt;Курс &lt;img src="@@PLUGINFILE@@/logo.png"&gt;&lt;/p&gt;</summary><format>topics</format><startdate>1735689600</startdate><enddate>0</enddate><customfields><customfield id="1"><shortname>Level</shortname><type>select</type><value>2</value><valueformat>0</valueformat></customfield><customfield id="2"><shortname>starts</shortname><type>date</type><value>1767214800</value><valueformat>0</valueformat></customfield><customfield id="3"><shortname>about</shortname><type>textarea</type><value>&lt;p&gt;Для &lt;b&gt;всех&lt;/b&gt;&lt;/p&gt;</value><valueformat>1</valueformat></customfield><customfield id="4"><shortname>elsewhere</shortname><type>text</type><value>x</value><valueformat>0</valueformat></customfield></customfields></course>`,
    'sections/section_1/section.xml': `<?xml version="1.0" encoding="UTF-8"?><section id="1"><number>0</number><name>$@NULL@$</name><summary></summary><sequence>11,14</sequence><visible>1</visible></section>`,
    'sections/section_2/section.xml': `<?xml version="1.0" encoding="UTF-8"?><section id="2"><number>1</number><name>Тема 1</name><summary>&lt;p&gt;Первая тема&lt;/p&gt;</summary><sequence>12,13,15,16,17,18,19,20,21,22,23,24,25,26,27</sequence><visible>1</visible></section>`,

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
    'activities/assign_13/module.xml': moduleXml(13, 'assign', 2, 0, {
      idnumber: 'essay',
      groupmode: 1,
    }),
    'activities/assign_13/assign.xml': wrap(
      13,
      'assign',
      33,
      '<name>Задание</name><intro>&lt;p&gt;Сдайте код&lt;/p&gt;</intro><duedate>1767225600</duedate><allowsubmissionsfromdate>0</allowsubmissionsfromdate><cutoffdate>0</cutoffdate><grade>20</grade><submissiondrafts>1</submissiondrafts>' +
        '<requiresubmissionstatement>1</requiresubmissionstatement><teamsubmission>1</teamsubmission><requireallteammemberssubmit>0</requireallteammemberssubmit><teamsubmissiongroupingid>71</teamsubmissiongroupingid><preventsubmissionnotingroup>1</preventsubmissionnotingroup>' +
        '<blindmarking>1</blindmarking><revealidentities>0</revealidentities><markingworkflow>1</markingworkflow><markingallocation>1</markingallocation><attemptreopenmethod>manual</attemptreopenmethod><maxattempts>3</maxattempts>' +
        '<plugin_configs><plugin_config id="1"><plugin>onlinetext</plugin><subtype>assignsubmission</subtype><name>enabled</name><value>0</value></plugin_config>' +
        '<plugin_config id="2"><plugin>file</plugin><subtype>assignsubmission</subtype><name>enabled</name><value>1</value></plugin_config>' +
        '<plugin_config id="3"><plugin>file</plugin><subtype>assignsubmission</subtype><name>maxfilesubmissions</name><value>2</value></plugin_config>' +
        '<plugin_config id="4"><plugin>file</plugin><subtype>assignsubmission</subtype><name>maxsubmissionsizebytes</name><value>3145728</value></plugin_config></plugin_configs>' +
        '<overrides><override id="1"><groupid>61</groupid><userid>$@NULL@$</userid><sortorder>1</sortorder><allowsubmissionsfromdate>0</allowsubmissionsfromdate><duedate>1767312000</duedate><cutoffdate>0</cutoffdate></override>' +
        '<override id="2"><groupid>$@NULL@$</groupid><userid>5</userid><sortorder>$@NULL@$</sortorder><duedate>1767400000</duedate></override></overrides>',
    ),
    'activities/assign_13/grading.xml': `<?xml version="1.0" encoding="UTF-8"?><areas><area id="1"><areaname>submissions</areaname><activemethod>rubric</activemethod><definitions><definition id="7"><method>rubric</method><name>Рубрика</name><options>{"sortlevelsasc":"1","lockzeropoints":"0"}</options><plugin_gradingform_rubric_definition><criteria>
      <criterion id="22"><sortorder>2</sortorder><description>Стиль кода</description><levels><level id="221"><score>0</score><definition>Трудно читать</definition></level><level id="222"><score>2</score><definition>Аккуратно</definition></level></levels></criterion>
      <criterion id="21"><sortorder>1</sortorder><description>&lt;p&gt;Верность&lt;/p&gt;</description><levels><level id="211"><score>1</score><definition>Не работает</definition></level><level id="212"><score>4</score><definition>Работает</definition></level></levels></criterion>
    </criteria></plugin_gradingform_rubric_definition></definition></definitions></area></areas>`,
    'activities/assign_13/grades.xml': `<?xml version="1.0" encoding="UTF-8"?><activity_gradebook><grade_items><grade_item id="101"><categoryid>201</categoryid><itemname>Задание</itemname><itemtype>mod</itemtype><itemmodule>assign</itemmodule><iteminstance>13</iteminstance><itemnumber>0</itemnumber><idnumber>essay</idnumber><aggregationcoef>3</aggregationcoef></grade_item></grade_items></activity_gradebook>`,
    'groups.xml': `<?xml version="1.0" encoding="UTF-8"?><groups><group id="61"><name>Команда А</name><idnumber>A</idnumber><description></description></group><group id="62"><name>Команда Б</name><idnumber></idnumber><description></description></group>
      <groupings><grouping id="71"><name>Команды</name><description></description><grouping_groups><grouping_group id="1"><groupid>61</groupid></grouping_group><grouping_group id="2"><groupid>62</groupid></grouping_group></grouping_groups></grouping></groupings></groups>`,
    'scales.xml': `<?xml version="1.0" encoding="UTF-8"?><scales_definition><scale id="5"><courseid>0</courseid><name>Качество</name><scale>Слабо,Хорошо,Отлично</scale></scale></scales_definition>`,
    'gradebook.xml': `<?xml version="1.0" encoding="UTF-8"?><gradebook><grade_categories>
      <grade_category id="201"><parent>200</parent><depth>2</depth><fullname>Работы</fullname><aggregation>10</aggregation><keephigh>0</keephigh><droplow>1</droplow><aggregateonlygraded>1</aggregateonlygraded><hidden>0</hidden></grade_category>
      <grade_category id="200"><parent>$@NULL@$</parent><depth>1</depth><fullname>?</fullname><aggregation>13</aggregation><keephigh>0</keephigh><droplow>0</droplow><aggregateonlygraded>1</aggregateonlygraded><hidden>0</hidden></grade_category>
    </grade_categories><grade_items>
      <grade_item id="300"><categoryid>$@NULL@$</categoryid><itemname>$@NULL@$</itemname><itemtype>course</itemtype><iteminstance>200</iteminstance><gradetype>1</gradetype><grademax>100</grademax></grade_item>
      <grade_item id="301"><categoryid>$@NULL@$</categoryid><itemname>$@NULL@$</itemname><itemtype>category</itemtype><iteminstance>201</iteminstance><idnumber>works</idnumber><gradetype>1</gradetype><grademax>100</grademax><aggregationcoef>2</aggregationcoef></grade_item>
      <grade_item id="302"><categoryid>201</categoryid><itemname>Устный ответ</itemname><itemtype>manual</itemtype><idnumber>oral</idnumber><gradetype>1</gradetype><grademax>10</grademax><grademin>0</grademin><gradepass>6</gradepass><aggregationcoef>1</aggregationcoef><display>2</display><decimals>1</decimals><hidden>0</hidden><locked>0</locked><sortorder>3</sortorder></grade_item>
      <grade_item id="303"><categoryid>200</categoryid><itemname>Итог</itemname><itemtype>manual</itemtype><idnumber>final</idnumber><calculation>=##gi101## + ##gi302## * 2 + ##gi301##</calculation><gradetype>1</gradetype><grademax>200</grademax><sortorder>4</sortorder></grade_item>
      <grade_item id="304"><categoryid>200</categoryid><itemname>Заметка</itemname><itemtype>manual</itemtype><gradetype>3</gradetype></grade_item>
    </grade_items><grade_letters><grade_letter id="1"><lowerboundary>90</lowerboundary><letter>A</letter></grade_letter><grade_letter id="2"><lowerboundary>0</lowerboundary><letter>F</letter></grade_letter></grade_letters></gradebook>`,
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
      '<type>qanda</type><name>Вопросы</name><intro></intro><assessed>1</assessed><scale>-5</scale><assesstimestart>1735689600</assesstimestart><assesstimefinish>0</assesstimefinish><grade_forum>20</grade_forum>',
    ),
    'activities/forum_17/module.xml': moduleXml(17, 'forum', 2),
    'activities/forum_17/forum.xml': wrap(
      17,
      'forum',
      37,
      '<type>news</type><name>Новости</name><intro></intro>',
    ),
    'activities/book_19/module.xml': moduleXml(19, 'book', 2),
    'activities/book_19/book.xml': wrap(
      19,
      'book',
      39,
      '<name>Учебник</name><intro></intro><numbering>3</numbering><navstyle>1</navstyle><customtitles>0</customtitles><chapters>' +
        '<chapter id="8"><pagenum>2</pagenum><subchapter>1</subchapter><title>Подробности</title><content>&lt;p&gt;Скрытая&lt;/p&gt;</content><contentformat>1</contentformat><hidden>1</hidden></chapter>' +
        '<chapter id="7"><pagenum>1</pagenum><subchapter>0</subchapter><title>Глава 1</title><content><![CDATA[<p>Схема <img src="@@PLUGINFILE@@/fig.png" alt="f"></p>]]></content><contentformat>1</contentformat><hidden>0</hidden></chapter>' +
        '</chapters>',
    ),
    'activities/choice_20/module.xml': moduleXml(20, 'choice', 2),
    'activities/choice_20/choice.xml': wrap(
      20,
      'choice',
      40,
      '<name>Тема проекта</name><intro></intro><publish>1</publish><showresults>2</showresults><display>0</display><allowupdate>1</allowupdate><allowmultiple>0</allowmultiple><showunanswered>0</showunanswered><limitanswers>1</limitanswers><timeopen>0</timeopen><timeclose>1767225600</timeclose><showpreview>0</showpreview>' +
        '<options><option id="1"><text>Чат-бот</text><maxanswers>3</maxanswers></option><option id="2"><text>Игра</text><maxanswers>0</maxanswers></option></options>',
    ),
    'activities/feedback_21/module.xml': moduleXml(21, 'feedback', 2),
    'activities/feedback_21/feedback.xml': wrap(
      21,
      'feedback',
      41,
      '<name>Отзыв</name><intro></intro><anonymous>2</anonymous><email_notification>0</email_notification><multiple_submit>0</multiple_submit><autonumbering>1</autonumbering><page_after_submit>&lt;p&gt;Спасибо!&lt;/p&gt;</page_after_submit><publish_stats>1</publish_stats><timeopen>0</timeopen><timeclose>0</timeclose><items>' +
        '<item id="1"><name>Как вам курс?</name><label>q1</label><presentation>r&gt;&gt;&gt;&gt;&gt;Отлично|Хорошо|Плохо</presentation><typ>multichoice</typ><position>1</position><required>1</required></item>' +
        '<item id="2"><name></name><presentation></presentation><typ>pagebreak</typ><position>2</position><required>0</required></item>' +
        '<item id="3"><name>Оценка</name><presentation>1|10</presentation><typ>numeric</typ><position>3</position><required>0</required></item>' +
        '<item id="4"><name>Что улучшить?</name><presentation>30|5</presentation><typ>textarea</typ><position>4</position><required>0</required></item>' +
        '<item id="5"><name>Код</name><presentation></presentation><typ>captcha</typ><position>5</position><required>1</required></item>' +
        '</items>',
    ),
    'activities/glossary_22/module.xml': moduleXml(22, 'glossary', 2),
    'activities/glossary_22/glossary.xml': wrap(
      22,
      'glossary',
      42,
      '<name>Словарь</name><intro></intro><allowduplicatedentries>0</allowduplicatedentries><displayformat>fullwithauthor</displayformat><mainglossary>0</mainglossary><showspecial>1</showspecial><showalphabet>1</showalphabet><showall>1</showall><allowcomments>0</allowcomments><usedynalink>1</usedynalink><defaultapproval>0</defaultapproval><globalglossary>0</globalglossary><entbypage>15</entbypage><editalways>0</editalways><assessed>1</assessed><assesstimestart>0</assesstimestart><assesstimefinish>0</assesstimefinish><scale>5</scale>' +
        '<entries><entry id="1"><userid>3</userid><concept>Список</concept><definition>&lt;p&gt;Изменяемая последовательность&lt;/p&gt;</definition><approved>1</approved><usedynalink>1</usedynalink><casesensitive>0</casesensitive><fullmatch>1</fullmatch></entry></entries>',
    ),
    'activities/lesson_23/module.xml': moduleXml(23, 'lesson', 2),
    'activities/lesson_23/lesson.xml': wrap(
      23,
      'lesson',
      43,
      '<name>Маршрут</name><intro></intro><practice>0</practice><modattempts>0</modattempts><usepassword>1</usepassword><password>5ebe2294ecd0e0f08eab7690d2a6ee69</password><dependency>0</dependency><grade>20</grade><custom>1</custom><ongoing>1</ongoing><usemaxgrade>1</usemaxgrade><maxanswers>4</maxanswers><maxattempts>3</maxattempts><review>1</review><nextpagedefault>0</nextpagedefault><feedback>0</feedback><minquestions>0</minquestions><maxpages>1</maxpages><timelimit>1200</timelimit><retake>1</retake><slideshow>0</slideshow><displayleft>1</displayleft><progressbar>1</progressbar><available>0</available><deadline>0</deadline>' +
        '<pages><page id="4"><prevpageid>3</prevpageid><nextpageid>0</nextpageid><qtype>10</qtype><qoption>0</qoption><layout>0</layout><display>1</display><title>Эссе</title><contents>&lt;p&gt;Зачем?&lt;/p&gt;</contents><contentsformat>1</contentsformat><answers><answer id="44"><jumpto>-9</jumpto><grade>0</grade><score>3</score><flags>0</flags><answer_text></answer_text><response></response><answerformat>0</answerformat><responseformat>0</responseformat></answer></answers></page><page id="1"><prevpageid>0</prevpageid><nextpageid>2</nextpageid><qtype>20</qtype><qoption>0</qoption><layout>1</layout><display>1</display><title>Начало</title><contents>&lt;p&gt;Карта &lt;img src="@@PLUGINFILE@@/map.png"&gt;&lt;/p&gt;</contents><contentsformat>1</contentsformat><answers><answer id="11"><jumpto>-1</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text>Дальше</answer_text><response></response><answerformat>0</answerformat><responseformat>0</responseformat></answer><answer id="12"><jumpto>3</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text>К соответствию</answer_text><response></response><answerformat>0</answerformat><responseformat>0</responseformat></answer></answers></page><page id="2"><prevpageid>1</prevpageid><nextpageid>3</nextpageid><qtype>2</qtype><qoption>0</qoption><layout>0</layout><display>1</display><title>Истина</title><contents>&lt;p&gt;2+2=4?&lt;/p&gt;</contents><contentsformat>1</contentsformat><answers><answer id="21"><jumpto>-1</jumpto><grade>0</grade><score>1</score><flags>0</flags><answer_text>Верно</answer_text><response>&lt;p&gt;Да&lt;/p&gt;</response><answerformat>0</answerformat><responseformat>0</responseformat></answer><answer id="22"><jumpto>0</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text>Неверно</answer_text><response></response><answerformat>0</answerformat><responseformat>0</responseformat></answer></answers></page><page id="3"><prevpageid>2</prevpageid><nextpageid>4</nextpageid><qtype>5</qtype><qoption>0</qoption><layout>0</layout><display>1</display><title>Пары</title><contents>&lt;p&gt;Сопоставьте&lt;/p&gt;</contents><contentsformat>1</contentsformat><answers><answer id="31"><jumpto>-1</jumpto><grade>0</grade><score>2</score><flags>0</flags><answer_text></answer_text><response>Отлично</response><answerformat>0</answerformat><responseformat>0</responseformat></answer><answer id="32"><jumpto>0</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text></answer_text><response>Ошибка</response><answerformat>0</answerformat><responseformat>0</responseformat></answer><answer id="33"><jumpto>0</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text>H2O</answer_text><response>вода</response><answerformat>0</answerformat><responseformat>0</responseformat></answer><answer id="34"><jumpto>0</jumpto><grade>0</grade><score>0</score><flags>0</flags><answer_text>NaCl</answer_text><response>соль</response><answerformat>0</answerformat><responseformat>0</responseformat></answer></answers></page></pages>',
    ),
    'activities/wiki_18/module.xml': moduleXml(18, 'wiki', 2),
    'activities/wiki_18/wiki.xml': wrap(
      18,
      'wiki',
      38,
      '<name>Вики</name><intro>&lt;p&gt;Общая вики&lt;/p&gt;</intro><firstpagetitle>Начало</firstpagetitle><wikimode>individual</wikimode><defaultformat>html</defaultformat><forceformat>1</forceformat><editbegin>0</editbegin><editend>0</editend>' +
        '<subwikis><subwiki id="1"><groupid>0</groupid><userid>3</userid><pages><page id="1"><title>Начало</title><cachedcontent>&lt;p&gt;x&lt;/p&gt;</cachedcontent></page></pages></subwiki></subwikis>',
    ),
    'activities/data_25/module.xml': moduleXml(25, 'data', 2),
    'activities/data_25/data.xml': wrap(
      25,
      'data',
      45,
      '<name>Каталог</name><intro></intro><timeavailablefrom>0</timeavailablefrom><timeavailableto>0</timeavailableto><requiredentries>0</requiredentries><requiredentriestoview>1</requiredentriestoview><maxentries>3</maxentries><approval>1</approval><manageapproved>1</manageapproved><scale>10</scale><assessed>1</assessed><assesstimestart>0</assesstimestart><assesstimefinish>0</assesstimefinish><defaultsort>52</defaultsort><defaultsortdir>1</defaultsortdir>' +
        '<listtemplate>&lt;p&gt;[[Книга]] ([[Год]]) ##more## ##delete##&lt;/p&gt;</listtemplate><singletemplate>&lt;h3&gt;[[Книга]]&lt;/h3&gt;&lt;p&gt;[[Жанр]]&lt;/p&gt;</singletemplate>' +
        '<fields><field id="51"><type>text</type><name>Книга</name><description></description><required>1</required><param1></param1><param2></param2></field><field id="52"><type>number</type><name>Год</name><description></description><required>0</required><param1></param1><param2></param2></field><field id="53"><type>radiobutton</type><name>Жанр</name><description></description><required>0</required><param1>Роман\nПовесть</param1><param2></param2></field><field id="54"><type>latlong</type><name>Место</name><description></description><required>0</required><param1></param1><param2></param2></field><field id="55"><type>picture</type><name>Обложка</name><description></description><required>0</required><param1></param1><param2></param2></field><field id="56"><type>url</type><name>Сайт</name><description></description><required>0</required><param1>0</param1><param2>Открыть</param2></field></fields><records><record id="1"><userid>3</userid></record></records>',
    ),
    'activities/workshop_26/module.xml': moduleXml(26, 'workshop', 2),
    'activities/workshop_26/workshop.xml': wrap(
      26,
      'workshop',
      46,
      '<name>Рецензии</name><intro></intro><instructauthors>&lt;p&gt;Напишите эссе&lt;/p&gt;</instructauthors><instructreviewers></instructreviewers><phase>30</phase><useexamples>0</useexamples><usepeerassessment>1</usepeerassessment><useselfassessment>1</useselfassessment><grade>60.00000</grade><gradinggrade>40.00000</gradinggrade><strategy>rubric</strategy><evaluation>best</evaluation><submissiontypetext>2</submissiontypetext><submissiontypefile>0</submissiontypefile><nattachments>0</nattachments><latesubmissions>1</latesubmissions><submissionstart>0</submissionstart><submissionend>1767225600</submissionend><assessmentstart>0</assessmentstart><assessmentend>0</assessmentend><phaseswitchassessment>1</phaseswitchassessment><conclusion></conclusion>' +
        '<subplugin_workshopform_rubric_workshop><workshopform_rubric_criteria><workshopform_rubric_criterion id="1"><sort>1</sort><description>&lt;p&gt;Аргументы&lt;/p&gt;</description><workshopform_rubric_levels><workshopform_rubric_level id="1"><grade>2</grade><definition>Есть</definition></workshopform_rubric_level><workshopform_rubric_level id="2"><grade>0</grade><definition>Нет</definition></workshopform_rubric_level></workshopform_rubric_levels></workshopform_rubric_criterion></workshopform_rubric_criteria></subplugin_workshopform_rubric_workshop>' +
        '<subplugin_workshopeval_best_workshop><workshopeval_best_setting id="1"><comparison>3</comparison></workshopeval_best_setting></subplugin_workshopeval_best_workshop>' +
        '<submissions><submission id="1"><authorid>3</authorid><title>Эссе</title></submission></submissions>',
    ),
    'activities/h5pactivity_27/module.xml': moduleXml(27, 'h5pactivity', 2),
    'activities/h5pactivity_27/h5pactivity.xml': wrap(
      27,
      'h5pactivity',
      47,
      '<name>Интерактив</name><intro></intro><grade>20</grade><displayoptions>9</displayoptions><enabletracking>1</enabletracking><grademethod>2</grademethod><reviewmode>1</reviewmode>' +
        '<attempts><attempt id="1"><userid>5</userid><attempt>1</attempt><rawscore>1</rawscore><maxscore>1</maxscore><scaled>1</scaled><completion>1</completion><success>1</success></attempt></attempts>',
    ),
    'activities/imscp_24/module.xml': moduleXml(24, 'imscp', 2),
    'activities/imscp_24/imscp.xml': wrap(24, 'imscp', 44, '<name>Пакет</name><intro></intro>'),

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
      <question_bank_entry id="10"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="11"><version>1</version><questions>
        <question id="100"><parent>0</parent><name>Вложенные</name><questiontext>&lt;p&gt;Столица — {#1}, тип — {#2}&lt;/p&gt;</questiontext><defaultmark>3</defaultmark><qtype>multianswer</qtype>
          <plugin_qtype_multianswer_question><multianswer id="1"><question>100</question><sequence>101,102</sequence></multianswer></plugin_qtype_multianswer_question>
        </question>
        <question id="101"><parent>100</parent><name>Вложенные 1</name><questiontext>{1:SA:=Париж}</questiontext><defaultmark>1</defaultmark><qtype>shortanswer</qtype>
          <plugin_qtype_shortanswer_question><answers><answer id="1011"><answertext>Париж</answertext><fraction>1.0000000</fraction><feedback>&lt;p&gt;Верно&lt;/p&gt;</feedback></answer></answers><shortanswer id="1"><usecase>0</usecase></shortanswer></plugin_qtype_shortanswer_question>
        </question>
        <question id="102"><parent>100</parent><name>Вложенные 2</name><questiontext>{2:MCV:=list~tuple}</questiontext><defaultmark>2</defaultmark><qtype>multichoice</qtype>
          <plugin_qtype_multichoice_question><answers>
            <answer id="1021"><answertext>&lt;p&gt;list&lt;/p&gt;</answertext><fraction>1.0000000</fraction><feedback></feedback></answer>
            <answer id="1022"><answertext>tuple</answertext><fraction>0.0000000</fraction><feedback></feedback></answer>
          </answers><multichoice id="2"><layout>1</layout><single>1</single><shuffleanswers>0</shuffleanswers></multichoice></plugin_qtype_multichoice_question>
        </question>
      </questions></question_versions></question_version></question_bank_entry>
      <question_bank_entry id="11"><questioncategoryid>2</questioncategoryid><question_version><question_versions id="12"><version>1</version><questions>
        <question id="110"><parent>0</parent><name>Скорость</name><questiontext>&lt;p&gt;{s} км за {t} ч: скорость?&lt;/p&gt;</questiontext><defaultmark>1</defaultmark><penalty>0.3333333</penalty><qtype>calculated</qtype>
          <plugin_qtype_calculated_question>
            <answers><answer id="1101"><answertext>{s} / {t}</answertext><answerformat>0</answerformat><fraction>1.0000000</fraction><feedback>Верно</feedback></answer></answers>
            <numerical_units><numerical_unit id="1"><multiplier>1</multiplier><unit>км/ч</unit></numerical_unit></numerical_units>
            <dataset_definitions>
              <dataset_definition id="21"><category>0</category><name>s</name><type>1</type><options>uniform:100:500:0</options><itemcount>2</itemcount>
                <dataset_items><dataset_item id="1"><number>1</number><value>120</value></dataset_item><dataset_item id="2"><number>2</number><value>300</value></dataset_item></dataset_items></dataset_definition>
              <dataset_definition id="22"><category>2</category><name>t</name><type>1</type><options>uniform:1:5:0</options><itemcount>2</itemcount>
                <dataset_items><dataset_item id="3"><number>1</number><value>2</value></dataset_item><dataset_item id="4"><number>2</number><value>3</value></dataset_item></dataset_items></dataset_definition>
            </dataset_definitions>
            <calculated_records><calculated_record id="1"><answer>1101</answer><tolerance>0.1</tolerance><tolerancetype>1</tolerancetype><correctanswerlength>1</correctanswerlength><correctanswerformat>1</correctanswerformat></calculated_record></calculated_records>
            <calculated_options><calculated_option id="1"><synchronize>0</synchronize><single>0</single><shuffleanswers>0</shuffleanswers></calculated_option></calculated_options>
          </plugin_qtype_calculated_question>
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
    item?: number;
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
      ctx: 39,
      component: 'mod_book',
      area: 'chapter',
      item: 7,
      name: 'fig.png',
      mime: 'image/png',
      data: Buffer.concat([PNG, Buffer.from([7])]),
    },
    {
      ctx: 43,
      component: 'mod_lesson',
      area: 'page_contents',
      item: 1,
      name: 'map.png',
      mime: 'image/png',
      data: Buffer.concat([PNG, Buffer.from([23])]),
    },
    {
      ctx: 47,
      component: 'mod_h5pactivity',
      area: 'package',
      name: 'check.h5p',
      mime: 'application/zip.h5p',
      data: Buffer.from('PK\x03\x04 h5p'),
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
        `<file id="${i + 1}"><contenthash>${hash(b.data)}</contenthash><contextid>${b.ctx}</contextid><component>${b.component}</component><filearea>${b.area}</filearea><itemid>${b.item ?? 0}</itemid><filepath>/</filepath><filename>${b.name}</filename><mimetype>${b.mime}</mimetype></file>`,
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
