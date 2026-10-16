import { strToU8, zipSync } from 'fflate';

// The demo's SCORM and H5P packages, built here rather than kept as binary files: a short
// quiz each, written for the demo literature course. Hubium ships no H5P libraries, so the
// H5P package carries its own small one, as every .h5p file does.

interface Question {
  text: string;
  answers: string[];
  /** Index of the right answer. */
  correct: number;
}

const SCORM_QUESTIONS: Question[] = [
  {
    text: 'Кто покупает вишнёвый сад на торгах?',
    answers: ['Ермолай Лопахин', 'Леонид Гаев', 'Петя Трофимов'],
    correct: 0,
  },
  {
    text: 'Кто из героев говорит: «Вся Россия — наш сад»?',
    answers: ['Лопахин', 'Петя Трофимов', 'Раневская'],
    correct: 1,
  },
  {
    text: 'Как Чехов определил жанр «Вишнёвого сада»?',
    answers: ['Драма', 'Трагедия', 'Комедия'],
    correct: 2,
  },
];

const H5P_QUESTIONS: Question[] = [
  {
    text: '«Человек в футляре»: какой предмет преподаёт Беликов?',
    answers: ['Историю', 'Греческий язык', 'Математику'],
    correct: 1,
  },
  {
    text: '«Крыжовник»: о чём всю жизнь мечтал Николай Иваныч?',
    answers: ['Об усадьбе с крыжовником', 'О поездке за границу', 'О службе в столице'],
    correct: 0,
  },
  {
    text: '«Ионыч»: кем служит Дмитрий Старцев?',
    answers: ['Учителем гимназии', 'Судьёй', 'Земским врачом'],
    correct: 2,
  },
];

const QUIZ_CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1f2937;background:#fff}
h1{font-size:1.4em;margin:0 0 .5em}fieldset{border:1px solid #d1d5db;border-radius:8px;margin:0 0 16px;padding:12px 16px}
legend{font-weight:600;padding:0 4px}label{display:block;padding:4px 0;cursor:pointer}
button{font:inherit;padding:8px 16px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}.right{color:#047857}.wrong{color:#b91c1c}
#result{font-weight:600;margin-top:12px}`;

/** A SCORM 1.2 package of one SCO: a quiz on «Вишнёвый сад», passed from 70 %. */
export function demoScormPackage(): Uint8Array {
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="hubium-demo-chekhov" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org">
    <organization identifier="org"><title>«Вишнёвый сад»: интерактивный урок</title>
      <item identifier="quiz" identifierref="res"><title>Проверьте себя</title><adlcp:masteryscore>70</adlcp:masteryscore></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/><file href="quiz.css"/>
    </resource>
  </resources>
</manifest>`;
  const sco = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>«Вишнёвый сад»</title><link rel="stylesheet" href="quiz.css"></head><body>
<h1>«Вишнёвый сад»: проверьте себя</h1>
<p>Пьеса А. П. Чехова написана в 1903 году. Ответьте на три вопроса: для зачёта нужно 70 %.</p>
<form id="quiz"></form><button type="button" id="check">Проверить</button>
<p id="result" role="status" aria-live="polite"></p>
<script>
var QUESTIONS=${JSON.stringify(SCORM_QUESTIONS)};
function findAPI(w){for(var i=0;i<10&&w;i++){if(w.API)return w.API;if(w.parent===w)break;w=w.parent}return null}
var api=findAPI(window);
if(api)api.LMSInitialize('');
var form=document.getElementById('quiz');
QUESTIONS.forEach(function(q,i){
  var fs=document.createElement('fieldset');var lg=document.createElement('legend');
  lg.textContent=(i+1)+'. '+q.text;fs.appendChild(lg);
  q.answers.forEach(function(a,j){
    var l=document.createElement('label');var r=document.createElement('input');
    r.type='radio';r.name='q'+i;r.value=j;l.appendChild(r);l.appendChild(document.createTextNode(' '+a));fs.appendChild(l);
  });
  form.appendChild(fs);
});
var status=api?api.LMSGetValue('cmi.core.lesson_status'):'';
if(status==='passed'||status==='failed')
  document.getElementById('result').textContent='Прошлый результат: '+api.LMSGetValue('cmi.core.score.raw')+' %.';
document.getElementById('check').onclick=function(){
  var right=0;
  QUESTIONS.forEach(function(q,i){
    var c=form.querySelector('input[name=q'+i+']:checked');
    var ok=c&&Number(c.value)===q.correct;if(ok)right++;
    form.elements['q'+i][q.correct].parentNode.className='right';
    if(c&&!ok)c.parentNode.className='wrong';
  });
  var score=Math.round(right/QUESTIONS.length*100);
  document.getElementById('result').textContent='Верных ответов: '+right+' из '+QUESTIONS.length+' ('+score+' %).';
  if(api){
    api.LMSSetValue('cmi.core.score.min','0');api.LMSSetValue('cmi.core.score.max','100');
    api.LMSSetValue('cmi.core.score.raw',String(score));
    api.LMSSetValue('cmi.core.lesson_status',score>=70?'passed':'failed');
    api.LMSCommit('');
  }
};
window.addEventListener('pagehide',function(){if(api)api.LMSFinish('')});
</script></body></html>`;
  return zipSync({
    'imsmanifest.xml': strToU8(manifest),
    'index.html': strToU8(sco),
    'quiz.css': strToU8(QUIZ_CSS),
  });
}

// H5P content type of our own: questions with one right answer each, reporting the score
// through H5P's xAPI as the content types from h5p.org do.
const H5P_LIBRARY_JS = `var H5P = H5P || {};
H5P.HubiumQuiz = (function () {
  function Quiz(params, id) {
    H5P.EventDispatcher.call(this);
    this.params = params;
    this.contentId = id;
  }
  Quiz.prototype = Object.create(H5P.EventDispatcher.prototype);
  Quiz.prototype.constructor = Quiz;
  Quiz.prototype.attach = function ($container) {
    var self = this;
    var p = self.params;
    var root = $container.get ? $container.get(0) : $container;
    root.classList.add('h5p-hubium-quiz');
    var form = document.createElement('form');
    p.questions.forEach(function (q, i) {
      var fs = document.createElement('fieldset');
      var lg = document.createElement('legend');
      lg.textContent = (i + 1) + '. ' + q.text;
      fs.appendChild(lg);
      q.answers.forEach(function (a, j) {
        var l = document.createElement('label');
        var r = document.createElement('input');
        r.type = 'radio';
        r.name = 'q' + i;
        r.value = j;
        l.appendChild(r);
        l.appendChild(document.createTextNode(' ' + a));
        fs.appendChild(l);
      });
      form.appendChild(fs);
    });
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = p.checkLabel;
    var out = document.createElement('p');
    out.setAttribute('role', 'status');
    button.onclick = function () {
      var right = 0;
      p.questions.forEach(function (q, i) {
        var c = form.querySelector('input[name=q' + i + ']:checked');
        var ok = c && Number(c.value) === q.correct;
        if (ok) right++;
        form.elements['q' + i][q.correct].parentNode.className = 'right';
        if (c && !ok) c.parentNode.className = 'wrong';
      });
      var max = p.questions.length;
      out.textContent = p.resultText.replace('@score', right).replace('@total', max);
      var e = self.createXAPIEventTemplate('completed');
      e.setScoredResult(right, max, self, true, right * 2 >= max);
      self.trigger(e);
    };
    root.append(form, button, out);
  };
  return Quiz;
})();
`;

const H5P_LIBRARY_CSS = `.h5p-hubium-quiz{font:16px/1.5 system-ui,sans-serif;padding:16px;color:#1f2937}
.h5p-hubium-quiz fieldset{border:1px solid #d1d5db;border-radius:8px;margin:0 0 16px;padding:12px 16px}
.h5p-hubium-quiz legend{font-weight:600;padding:0 4px}.h5p-hubium-quiz label{display:block;padding:4px 0}
.h5p-hubium-quiz button{font:inherit;padding:8px 16px;border:0;border-radius:6px;background:#2563eb;color:#fff}
.h5p-hubium-quiz .right{color:#047857}.h5p-hubium-quiz .wrong{color:#b91c1c}`;

/** An .h5p package with its library: a quiz on Chekhov's stories. */
export function demoH5pPackage(): Uint8Array {
  const json = (v: unknown) => strToU8(JSON.stringify(v));
  return zipSync({
    'h5p.json': json({
      title: 'Рассказы Чехова: самопроверка',
      language: 'ru',
      mainLibrary: 'H5P.HubiumQuiz',
      embedTypes: ['iframe'],
      license: 'U',
      preloadedDependencies: [
        { machineName: 'H5P.HubiumQuiz', majorVersion: '1', minorVersion: '0' },
      ],
    }),
    'content/content.json': json({
      questions: H5P_QUESTIONS,
      checkLabel: 'Проверить',
      resultText: 'Верных ответов: @score из @total.',
    }),
    'H5P.HubiumQuiz-1.0/library.json': json({
      title: 'Hubium quiz',
      machineName: 'H5P.HubiumQuiz',
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
      runnable: 1,
      embedTypes: ['iframe'],
      preloadedJs: [{ path: 'quiz.js' }],
      preloadedCss: [{ path: 'quiz.css' }],
    }),
    'H5P.HubiumQuiz-1.0/quiz.js': strToU8(H5P_LIBRARY_JS),
    'H5P.HubiumQuiz-1.0/quiz.css': strToU8(H5P_LIBRARY_CSS),
  });
}
