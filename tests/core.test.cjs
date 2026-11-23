const {test} = require('node:test');
const assert = require('node:assert/strict');
const S = require('../subtitles.js');
const source = require('../provider.js');

test('SRT parses Chinese, CRLF, hours and formatting; sorts by timestamp', () => {
  const rows = S.parse('\uFEFF2\r\n01:02:03,450 --> 01:02:05,000\r\n<i>中文</i> &amp; English\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,000\r\n第一句');
  assert.deepEqual(rows, [{start: 1, end: 2, text: '第一句'}, {start: 3723.45, end: 3725, text: '中文 & English'}]);
});
test('VTT cue IDs, settings and multiline content', () => {
  assert.deepEqual(S.parse('WEBVTT\n\ncue-1\n00:01.250 --> 00:03.500 align:start\nLine one\nLine two'),
    [{start: 1.25, end: 3.5, text: 'Line one\nLine two'}]);
});
test('ASS event fields, commas, line breaks and drawing exclusion', () => {
  const text = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.20,Default,,0,0,0,,{\\b1}你好, world\\N第二行\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 1 1';
  assert.deepEqual(S.parse(text), [{start: 1, end: 3.2, text: '你好, world\n第二行'}]);
});
test('Malformed, negative and reversed times never become display cues', () => {
  for (const text of ['', 'hello', '1\n00:61:00,000 --> 01:02:00,000\nBad', '1\n00:00:03,000 --> 00:00:01,000\nBad']) assert.throws(() => S.parse(text));
});
test('Offsets delay and advance without negative cue times', () => {
  const cues = [{start: 0, end: 1, text: 'A'}, {start: 2, end: 4, text: 'B'}];
  assert.deepEqual(S.shifted(cues, -3), [{start: 0, end: 1, text: 'B'}]);
  assert.equal(S.shifted(cues, .5)[0].start, .5);
  assert.throws(() => S.shifted(cues, NaN));
  assert.throws(() => S.shifted(cues, 3601));
});
test('UTF-8, UTF-16 and GB18030 Chinese decode correctly; archives rejected', () => {
  assert.equal(S.decode(new TextEncoder().encode('中文字幕').buffer), '中文字幕');
  assert.equal(S.decode(Uint8Array.from([0xd6,0xd0,0xce,0xc4]).buffer), '中文');
  assert.equal(S.decode(Uint8Array.from([0xff,0xfe,0x2d,0x4e,0x87,0x65]).buffer), '中文');
  for (const magic of [[0x50,0x4b], [0x52,0x61,0x72], [0x37,0x7a]]) assert.throws(() => S.decode(Uint8Array.from(magic).buffer), /archive/);
});
test('Keyless title lookup preserves Chinese language preference and matching title', async () => {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url.pathname, '/v1/by-title');
    assert.equal(url.searchParams.get('q'), '黑客帝国');
    assert.equal(url.searchParams.get('lang'), 'zh,zt');
    assert.equal(options.headers, undefined);
    return new Response(JSON.stringify({title:{name:'The Matrix',year:1999},subtitles:{total:3,items:[
      {id:1,release_name:'Matrix.CHN',language:'zh',format:'srt',download_url:'https://api.thesubtitledb.org/get/1'},
      {id:2,language:'en',format:'sub',download_url:'https://api.thesubtitledb.org/get/2'},
      {id:3,language:'zh',format:'srt',download_url:'https://evil.test/file.srt'}
    ]}}));
  };
  try {
    const result=await source.search('黑客帝国');
    assert.equal(result.title,'The Matrix · 1999');
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0].language,'Simplified Chinese');
  } finally { global.fetch=original; }
});
test('Episode and IMDb lookup use their documented routes', async () => {
  const original=global.fetch;
  let path, query;
  global.fetch=async url=>{path=url.pathname;query=url.searchParams.get('q');return new Response(JSON.stringify({title:{},subtitles:{items:[]}}));};
  try {
    await source.search('Breaking Bad S01E02','en');
    assert.equal(path,'/v1/by-title/season/1/episode/2');
    assert.equal(query,'Breaking Bad');
    await source.search('tt0133093','zh');
    assert.equal(path,'/v1/by-imdb/tt0133093');
    assert.equal(query,null);
  } finally {global.fetch=original;}
});
test('Missing titles are empty results; rate limits are explained', async () => {
  const original=global.fetch;
  try {
    global.fetch=async()=>new Response('{}',{status:404});
    assert.deepEqual(await source.search('Unknown Film'),{title:'',rows:[],total:0});
    global.fetch=async()=>new Response('{}',{status:429});
    await assert.rejects(()=>source.search('Movie'),/rate limiting/);
  } finally {global.fetch=original;}
});
test('Downloads reject unrelated hosts, embedded credentials and non-subtitle responses', async () => {
  for (const address of ['https://evil.test/file.srt','https://thesubtitledb.org.evil.test/a','http://localhost/a','https://user:pass@api.thesubtitledb.org/get/1','data:text/plain,hello']) {
    await assert.rejects(()=>source.download(address),/download address/);
  }
  const original=global.fetch;
  global.fetch=async()=>new Response('<html>Temporary error</html>');
  try {await assert.rejects(()=>source.download('https://api.thesubtitledb.org/get/1'),/valid subtitles/);}
  finally {global.fetch=original;}
});
test('Downloads use returned URLs, not invented file-host paths, with no credentials', async () => {
  const original=global.fetch;
  global.fetch=async(url,options)=>{
    assert.equal(url.pathname,'/get/123');
    assert.equal(options.headers,undefined);
    assert.equal(options.credentials,'omit');
    return new Response('1\n00:00:01,000 --> 00:00:02,000\n中文字幕');
  };
  try {assert.equal(S.parse(await source.download('https://api.thesubtitledb.org/get/123')).length,1);}
  finally {global.fetch=original;}
});

test('Include English works with every selected language without duplicate English filters', async () => {
  const original = global.fetch;
  let languages=[];
  global.fetch = async url => {languages.push(url.searchParams.get('lang'));return new Response(JSON.stringify({subtitles:{items:[]}}));};
  try {
    for (const [selected, expected] of [['zh,zt',['zh,zt','en']],['ja',['ja','en']],['ko',['ko','en']],['es,sp,ea',['es,sp,ea','en']],['pt,pb',['pt,pb','en']],['fr',['fr','en']],['ar',['ar','en']],['en',['en']],['',[null]]]) {
      languages=[];
      await source.search('Movie',selected,true); assert.deepEqual(languages,expected);
    }
    languages=[]; await source.search('Movie','ja',false); assert.deepEqual(languages,['ja']);
  } finally {global.fetch=original;}
});

test('All popup languages use supported filters and readable result labels', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(path.dirname(require.resolve('../provider.js')), 'popup.html'), 'utf8');
  const select = html.match(/<select id="language">([\s\S]*?)<\/select>/)[1];
  const options = [...select.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)];
  assert.equal(options.length, 29);
  const original = global.fetch;
  try {
    for (const [,filter,label] of options) {
      const code = filter.split(',')[0] || 'en';
      global.fetch = async url => {
        assert.equal(url.searchParams.get('lang'), filter || null);
        return new Response(JSON.stringify({subtitles:{items:[{id:1,release_name:'Movie',language:code,format:'srt',download_url:'https://api.thesubtitledb.org/get/1'}]}}));
      };
      const result = await source.search('Movie',filter);
      assert.notEqual(result.rows[0].language,code,label);
    }
    for (const code of ['pb','sp','ea']) {
      global.fetch=async()=>new Response(JSON.stringify({subtitles:{items:[{id:1,release_name:'Movie',language:code,format:'srt',download_url:'https://api.thesubtitledb.org/get/1'}]}}));
      assert.match((await source.search('Movie',code)).rows[0].language,/Brazil|Spain|Latin America/);
    }
    for (const filter of ['xx','es,xx','es,,en','__proto__']) await assert.rejects(()=>source.search('Movie',filter),/supported subtitle language/);
  } finally { global.fetch=original; }
});

test('Bilingual filenames rank first only when Include English is enabled; dual audio is not a subtitle hint', async () => {
  const original=global.fetch;
  global.fetch=async()=>new Response(JSON.stringify({title:{name:'Movie'},subtitles:{items:[
    {id:1,release_name:'Movie.English',language:'en',format:'srt',download_url:'https://api.thesubtitledb.org/get/1'},
    {id:2,release_name:'Movie.Dual.Audio',language:'zh',format:'srt',download_url:'https://api.thesubtitledb.org/get/2'},
    {id:3,release_name:'Movie.CHS&ENG',language:'zh',format:'ass',download_url:'https://api.thesubtitledb.org/get/3'},
    {id:4,release_name:'Movie.Japanese-English',language:'ja',format:'srt',download_url:'https://api.thesubtitledb.org/get/4'}
  ]}}));
  try {
    const paired=await source.search('Movie','zh,zt',true);
    assert.deepEqual(paired.rows.map(row=>row.id),[3,4,2,1]);
    assert.equal(paired.rows.find(row=>row.id===2).bilingualHint,false);
    assert.equal(paired.rows.find(row=>row.id===4).bilingualHint,true);
    assert.deepEqual((await source.search('Movie','zh,zt',false)).rows.map(row=>row.id),[1,2,3,4]);
  } finally {global.fetch=original;}
});

test('Pair lookup preserves primary results when English fails and never merges different films', async () => {
  const original=global.fetch;
  const primary={title:{name:'Movie A',year:2009},subtitles:{total:1,items:[{id:1,release_name:'Movie A',language:'zh',format:'srt',download_url:'https://api.thesubtitledb.org/get/1'}]}};
  try {
    global.fetch=async url=>url.searchParams.get('lang')==='en'?new Response('{}',{status:429}):new Response(JSON.stringify(primary));
    const partial=await source.search('Movie','zh,zt',true);
    assert.equal(partial.rows.length,1);assert.match(partial.notice,/English lookup failed/);
    global.fetch=async url=>new Response(JSON.stringify(url.searchParams.get('lang')==='en'?{title:{name:'Movie B',year:2020},subtitles:{items:[]}}:primary));
    const mismatch=await source.search('Movie','zh,zt',true);
    assert.equal(mismatch.title,'Movie A · 2009');assert.equal(mismatch.rows.length,1);assert.match(mismatch.notice,/different title/);
  } finally {global.fetch=original;}
});

test('Bilingual detection checks overlapping dialogue, including separate ASS events, rather than names and credits', () => {
  const primary=[0,4,8,12,16].map(start=>({start,end:start+3,text:'这是一句中文字幕。'}));
  assert.equal(S.hasEnglish(primary),false);
  assert.equal(S.hasEnglish(primary.map(cue=>({...cue,text:cue.text+' Mr Maxwell'}))),false);
  assert.equal(S.hasEnglish([...primary,{start:0,end:2,text:'Subtitles by Example Team'}]),false);
  assert.equal(S.hasEnglish(primary.map(cue=>({...cue,text:cue.text+'\nThis is English dialogue.'}))),true);
  assert.equal(S.hasEnglish([...primary,...primary.map(cue=>({...cue,text:'This is English dialogue.'}))]),true);
});

test('English matching prefers the selected release group and rejects commentary and incompatible frame rates', () => {
  const primary={name:'Zombieland.720p.BluRay.x264-CROSSBOW.chs',url:'https://source.test/cn',fps:23.976};
  const rows=[
    {name:'Zombieland.DVDRip-ARROW',languageCode:'en',url:'a'},
    {name:'Zombieland.2009.720p.BluRay.x264-CROSSBOW',languageCode:'en',url:'b'},
    {name:'Zombieland.CROSSBOW.COMMENTARY',languageCode:'en',url:'c'},
    {name:'Zombieland.CROSSBOW',languageCode:'en',url:'d',fps:25},
    {name:'Zombieland.CROSSBOW',languageCode:'zh',url:'e'}
  ];
  assert.deepEqual(S.englishCandidates(rows,primary).map(row=>row.url),['b','a']);
  assert.equal(S.similarDuration([{end:6000}],[{end:6001}]),true);
  assert.equal(S.similarDuration([{end:6000}],[{end:5760}]),false);
});
