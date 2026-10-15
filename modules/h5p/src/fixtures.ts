import { strToU8, zipSync } from 'fflate';

// A small H5P package for tests: one runnable library of our own whose button reports a
// scored "completed" statement through H5P's xAPI, as real content types do.

const LIBRARY_JS = `var H5P = H5P || {};
H5P.HubiumCheck = (function () {
  function Check(params, id) {
    H5P.EventDispatcher.call(this);
    this.params = params;
    this.contentId = id;
  }
  Check.prototype = Object.create(H5P.EventDispatcher.prototype);
  Check.prototype.constructor = Check;
  Check.prototype.attach = function ($container) {
    var self = this;
    var root = $container.get ? $container.get(0) : $container;
    var q = document.createElement('p');
    q.textContent = self.params.question;
    var out = document.createElement('p');
    function answer(right) {
      var e = self.createXAPIEventTemplate('completed');
      e.setScoredResult(right ? 1 : 0, 1, self, true, right);
      self.trigger(e);
      out.textContent = right ? self.params.right : self.params.wrong;
    }
    var yes = document.createElement('button');
    yes.textContent = self.params.yes;
    yes.onclick = function () { answer(true); };
    var no = document.createElement('button');
    no.textContent = self.params.no;
    no.onclick = function () { answer(false); };
    root.append(q, yes, no, out);
  };
  return Check;
})();
`;

export function h5pFixture(o: { withLibrary?: boolean; title?: string } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'h5p.json': strToU8(
      JSON.stringify({
        title: o.title ?? 'Проверка',
        language: 'ru',
        mainLibrary: 'H5P.HubiumCheck',
        embedTypes: ['iframe'],
        license: 'U',
        preloadedDependencies: [
          { machineName: 'H5P.HubiumCheck', majorVersion: '1', minorVersion: '0' },
        ],
      }),
    ),
    'content/content.json': strToU8(
      JSON.stringify({
        question: 'Дважды два — четыре?',
        yes: 'Да',
        no: 'Нет',
        right: 'Верно!',
        wrong: 'Неверно',
      }),
    ),
  };
  if (o.withLibrary !== false) {
    files['H5P.HubiumCheck-1.0/library.json'] = strToU8(
      JSON.stringify({
        title: 'Hubium check',
        machineName: 'H5P.HubiumCheck',
        majorVersion: 1,
        minorVersion: 0,
        patchVersion: 0,
        runnable: 1,
        embedTypes: ['iframe'],
        preloadedJs: [{ path: 'check.js' }],
      }),
    );
    files['H5P.HubiumCheck-1.0/check.js'] = strToU8(LIBRARY_JS);
  }
  return zipSync(files);
}
