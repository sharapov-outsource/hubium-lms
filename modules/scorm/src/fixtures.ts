import { strToU8, zipSync } from 'fflate';

// A tiny SCORM package for tests: the SCO starts, saves a location and suspends on the
// first launch, and passes with a score when resumed. It prints what it saw.

const sco12 = `<!doctype html><html><head><meta charset="utf-8"><title>SCO</title></head><body>
<h1>Тестовый SCO</h1><p id="state">…</p><p id="cookie"></p>
<script>
function findAPI(w){for(var i=0;i<10&&w;i++){if(w.API)return w.API;if(w.parent===w)break;w=w.parent}return null}
var api=findAPI(window);
api.LMSInitialize('');
var entry=api.LMSGetValue('cmi.core.entry');
var loc=api.LMSGetValue('cmi.core.lesson_location');
var name=api.LMSGetValue('cmi.core.student_name');
document.getElementById('cookie').textContent='cookie=['+document.cookie+']';
if(entry==='resume'){
  api.LMSSetValue('cmi.core.score.raw','85');
  api.LMSSetValue('cmi.core.lesson_status','passed');
  api.LMSSetValue('cmi.core.exit','');
} else {
  api.LMSSetValue('cmi.core.lesson_location','page-2');
  api.LMSSetValue('suspend_data','visited=1');
  api.LMSSetValue('cmi.core.lesson_status','incomplete');
  api.LMSSetValue('cmi.core.exit','suspend');
}
api.LMSSetValue('cmi.core.session_time','00:01:30');
api.LMSCommit('');
document.getElementById('state').textContent='entry='+entry+' location='+loc+' learner='+name;
</script></body></html>`;

const sco2004 = `<!doctype html><html><head><meta charset="utf-8"><title>SCO 2004</title></head><body>
<p id="state">…</p>
<script>
function findAPI(w){for(var i=0;i<10&&w;i++){if(w.API_1484_11)return w.API_1484_11;if(w.parent===w)break;w=w.parent}return null}
var api=findAPI(window);
api.Initialize('');
var entry=api.GetValue('cmi.entry');
if(entry==='resume'){
  api.SetValue('cmi.score.scaled','0.9');api.SetValue('cmi.score.raw','90');
  api.SetValue('cmi.completion_status','completed');api.SetValue('cmi.success_status','passed');
  api.SetValue('cmi.exit','normal');
} else {
  api.SetValue('cmi.location','slide-3');api.SetValue('cmi.suspend_data','s=3');
  api.SetValue('cmi.completion_status','incomplete');api.SetValue('cmi.exit','suspend');
}
api.SetValue('cmi.session_time','PT2M');
api.Commit('');
document.getElementById('state').textContent='entry='+entry+' location='+api.GetValue('cmi.location');
</script></body></html>`;

const manifest12 = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="hubium-test" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1"><title>Тестовый курс SCORM</title>
      <item identifier="item1" identifierref="res1"><title>Урок 1</title><adlcp:masteryscore>80</adlcp:masteryscore></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res1" type="webcontent" adlcp:scormtype="sco" href="sco/index.html"><file href="sco/index.html"/></resource>
  </resources>
</manifest>`;

const manifest2004 = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="hubium-2004" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="o"><organization identifier="o"><title>SCORM 2004</title>
    <item identifier="i1" identifierref="r1"><title>Часть 1</title></item>
    <item identifier="i2" identifierref="r1" parameters="?part=2"><title>Часть 2</title></item>
  </organization></organizations>
  <resources><resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="index.html"/></resources>
</manifest>`;

export function scormFixture(
  version: '1.2' | '2004' = '1.2',
  extra: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync(
    version === '1.2'
      ? { 'imsmanifest.xml': strToU8(manifest12), 'sco/index.html': strToU8(sco12), ...extra }
      : { 'imsmanifest.xml': strToU8(manifest2004), 'index.html': strToU8(sco2004), ...extra },
  );
}
