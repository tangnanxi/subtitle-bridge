(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let tab;
  let entries = [];
  let selected;
  let busy = false;
  let offset = 0;

  function refreshAddButtons() {
    for (const button of document.querySelectorAll('.add-second')) {
      button.disabled = busy || !selected?.count;
      button.textContent = selected?.fileCount === 2 ? 'Replace second' : 'Add second';
    }
  }

  function languageNote() {
    const redundant = ['en', ''].includes($('language').value);
    $('include-english').disabled = busy || redundant;
    $('language-note').hidden = !$('include-english').checked || redundant;
  }

  function message(text, error = false) {
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
  }

  async function run(button, task) {
    if (busy) return;
    busy = true;
    const interactive = [...document.querySelectorAll('button, #video, #file, #visible, #font-size, #language, #include-english')];
    const before = interactive.map(node => [node, node.disabled]);
    for (const node of interactive) node.disabled = true;
    const previous = button?.textContent;
    if (button) button.textContent = 'Working…';
    try { await task(); }
    catch (error) {
      const text = error.name === 'TimeoutError' ? 'The request timed out. Try again or import a subtitle file.'
        : error.message === 'Failed to fetch' ? 'Could not connect to the subtitle source. Check your connection and try again.' : error.message;
      if ($('video-status').textContent === 'Detecting video…') $('video-status').textContent = 'No video detected';
      message(text || 'Something went wrong. Please try again.', true);
    } finally {
      busy = false;
      for (const [node, disabled] of before) if (node.isConnected) node.disabled = disabled;
      if (button?.isConnected) button.textContent = previous;
      for (const node of document.querySelectorAll('.result button')) node.disabled = false;
      refreshAddButtons();
      languageNote();
    }
  }

  async function player(method, payload = {}) {
    if (!selected || !tab) throw new Error('No video detected. Start playback and click Detect again. For an embedded player, click Enable embedded players.');
    const results = await chrome.scripting.executeScript({
      target: {tabId: tab.id, frameIds: [selected.frameId]},
      func: (action, data) => {
        try {
          const controller = globalThis.SubtitleBridgePlayer;
          if (!controller) throw new Error('The page has reloaded. Click Detect again.');
          return {ok: true, data: controller[action](data)};
        } catch (error) { return {ok: false, error: error.message}; }
      }, args: [method, {id: selected.id, ...payload}]
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || 'Could not access the player. Click Detect again.');
    return result.data;
  }

  function renderLoaded(state) {
    const loaded = Boolean(state?.count);
    $('controls').disabled = !loaded;
    $('loaded-name').textContent = loaded ? `${state.name} · ${state.fileCount === 2 ? '2 files · ' : ''}${state.count} cues` : 'No subtitles loaded';
    offset = state?.offset || 0;
    $('offset').textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)} s`;
    $('visible').checked = state?.visible ?? true;
    if (state?.fontSize) $('font-size').value = state.fontSize;
    $('font-value').textContent = $('font-size').value;
    refreshAddButtons();
  }

  async function detect() {
    [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
      throw new Error('Open the extension on a video website. Browser settings pages do not support subtitles.');
    }
    let target = {tabId: tab.id, allFrames: true};
    try { await chrome.scripting.executeScript({target, files: ['subtitles.js', 'content.js']}); }
    catch { target = {tabId: tab.id}; await chrome.scripting.executeScript({target, files: ['subtitles.js', 'content.js']}); }
    const frames = await chrome.scripting.executeScript({target, func: () => ({
      videos: globalThis.SubtitleBridgePlayer?.status() || [], title: document.title,
      hasFrames: Boolean(document.querySelector('iframe'))
    })});
    const previous = selected && `${selected.frameId}:${selected.id}`;
    entries = frames.flatMap(frame => (frame.result?.videos || []).map(video => ({...video, frameId: frame.frameId})));
    entries.sort((a, b) => Number(Boolean(b.count)) - Number(Boolean(a.count)) || Number(b.playing) - Number(a.playing) || b.area - a.area);
    selected = entries.find(entry => `${entry.frameId}:${entry.id}` === previous) || entries[0];
    $('video').replaceChildren();
    entries.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = `${entry.frameId}:${entry.id}`;
      option.textContent = `Video ${index + 1}${entry.playing ? ' · Playing' : ''}${entry.duration ? ` · ${Math.floor(entry.duration / 60)} min` : ''}${entry.count ? ' · Subtitles loaded' : ''}`;
      $('video').append(option);
    });
    if (selected) $('video').value = `${selected.frameId}:${selected.id}`;
    $('video').hidden = entries.length < 2;
    $('video-status').textContent = entries.length ? `${entries.length} video${entries.length === 1 ? '' : 's'} detected` : 'No video detected';
    const framePermission = !entries.length || frames.some(frame => frame.result?.hasFrames);
    $('frame-access').hidden = !framePermission;
    $('frame-note').hidden = !framePermission;
    renderLoaded(selected);
    if (!$('query').value) {
      $('query').value = (tab.title || '').replace(/(?:在线观看|在线播放|高清完整版|免费播放).*$/, '').replace(/\s*[-_|｜].*$/, '').trim().slice(0, 160);
    }
    if (!entries.length) message('Start playback, then click Detect again. Embedded players may need extra permission.');
    return selected;
  }

  async function mount(text, name, append = false, secondary = null) {
    if (!selected) await detect();
    const loaded = await player('load', {text, name, append, secondary, fontSize: Number($('font-size').value)});
    Object.assign(selected, loaded, {visible: true, fontSize: Number($('font-size').value)});
    renderLoaded(selected);
    message(loaded.fileCount === 2 ? `Two subtitle files loaded together (${loaded.count} cues). Use matching releases to keep both languages in sync.`
      : `Loaded ${loaded.count} cues. Subtitles follow playback, seeking and pauses.`);
  }

  async function loadResult(row, rows, query, matchedTitle) {
    message('Downloading subtitles…');
    const text = await SubtitleSource.download(row.url);
    const cues = SubtitleBridge.parse(text);
    if (!$('include-english').checked || ['en', ''].includes($('language').value) || row.languageCode === 'en') {
      await mount(text, row.fileName); return;
    }
    if (SubtitleBridge.hasEnglish(cues)) {
      await mount(text, row.fileName);
      message(`Loaded ${cues.length} cues. This file already contains English alongside the selected language.`);
      return;
    }
    message('Finding English subtitles for this release…');
    let candidates = rows.filter(item => item.languageCode === 'en');
    let lookupFailed = false;
    if (!candidates.length) {
      try {
        const english = await SubtitleSource.search(query, 'en');
        if (!matchedTitle || english.title === matchedTitle) candidates = english.rows;
      } catch { lookupFailed = true; }
    }
    for (const candidate of SubtitleBridge.englishCandidates(candidates, row).slice(0, 2)) {
      try {
        const englishText = await SubtitleSource.download(candidate.url);
        const englishCues = SubtitleBridge.parse(englishText);
        if (!SubtitleBridge.similarDuration(cues, englishCues)) continue;
        await mount(text, row.fileName, false, {text: englishText, name: candidate.fileName});
        message('Selected language + English loaded together. Check timing against the dialogue.');
        return;
      } catch { lookupFailed = true; }
    }
    await mount(text, row.fileName);
    message(lookupFailed ? 'Selected language loaded. English lookup or download failed. Try loading again, or use Add second.'
      : 'Selected language loaded. No compatible English file was found. Choose an English release and use Add second.');
  }

  function resultText(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function renderResults(rows, query, matchedTitle) {
    $('results').replaceChildren();
    for (const row of rows) {
      const item = document.createElement('article');
      item.className = 'result';
      item.append(resultText('p', 'result-title', row.name));
      item.append(resultText('p', 'result-info', [row.language, row.format, row.fps && `${row.fps} fps`,
        row.bilingualHint && 'Likely bilingual (filename)'].filter(Boolean).join(' · ')));
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Load subtitles';
      button.addEventListener('click', () => run(button, async () => {
        await loadResult(row, rows, query, matchedTitle);
      }));
      item.append(button);
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'add-second';
      add.title = 'Keep the first file and add or replace a second subtitle file';
      add.addEventListener('click', () => run(add, async () => {
        message('Downloading the second subtitle file…');
        await mount(await SubtitleSource.download(row.url), row.fileName, true);
      }));
      item.append(add);
      $('results').append(item);
    }
    refreshAddButtons();
  }

  $('detect').addEventListener('click', () => run($('detect'), detect));
  $('frame-access').addEventListener('click', () => {
    const permission = chrome.permissions.request({origins: ['https://*/*', 'http://*/*']});
    run($('frame-access'), async () => {
      if (!await permission) throw new Error('Website access was not granted. You can still use subtitles with directly accessible videos.');
      await detect();
    });
  });
  $('video').addEventListener('change', () => {
    selected = entries.find(entry => `${entry.frameId}:${entry.id}` === $('video').value);
    renderLoaded(selected);
  });
  $('language').addEventListener('change', languageNote);
  $('include-english').addEventListener('change', () => run(null, async () => {
    languageNote();
    await chrome.storage.local.set({includeEnglish: $('include-english').checked});
  }));
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    run($('search'), async () => {
      message('Searching for subtitles…');
      $('results').replaceChildren();
      $('matched-title').hidden = true;
      const query = $('query').value.trim();
      const result = await SubtitleSource.search(query, $('language').value, $('include-english').checked);
      renderResults(result.rows, query, result.title);
      $('matched-title').textContent = result.title ? `Matched: ${result.title}. Check this is the right title.` : '';
      $('matched-title').hidden = !result.title;
      const summary = result.rows.length ? `${result.rows.length} subtitle file${result.rows.length === 1 ? '' : 's'} found. Check the title and release.` : 'No subtitles in this language from this source. For a series, add S01E01 for your episode. Try another language or import a file.';
      message([summary, result.notice].filter(Boolean).join(' '));
      await chrome.storage.local.set({subtitleLanguage: $('language').value, includeEnglish: $('include-english').checked});
    });
  });
  $('file').addEventListener('change', () => run(null, async () => {
    const file = $('file').files[0];
    if (!file) return;
    if (file.size > SubtitleBridge.LIMIT) throw new Error('This file exceeds 4 MB. Choose a smaller text subtitle file.');
    try { await mount(SubtitleBridge.decode(await file.arrayBuffer()), file.name); }
    finally { $('file').value = ''; }
  }));
  async function changeOffset(value) {
    const state = await player('configure', {offset: Math.round(value * 10) / 10});
    offset = state.offset;
    selected.offset = offset;
    $('offset').textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)} s`;
    message('Positive values delay subtitles; negative values show them earlier.');
  }
  $('earlier').addEventListener('click', () => run(null, () => changeOffset(offset - .5)));
  $('later').addEventListener('click', () => run(null, () => changeOffset(offset + .5)));
  $('reset').addEventListener('click', () => run(null, () => changeOffset(0)));
  $('visible').addEventListener('change', () => run(null, async () => {
    const state = await player('configure', {visible: $('visible').checked});
    selected.visible = state.visible;
  }));
  $('font-size').addEventListener('input', () => { $('font-value').textContent = $('font-size').value; });
  $('font-size').addEventListener('change', () => run(null, async () => {
    await player('configure', {fontSize: Number($('font-size').value)});
    selected.fontSize = Number($('font-size').value);
    await chrome.storage.local.set({fontSize: Number($('font-size').value)});
  }));
  $('clear').addEventListener('click', () => run(null, async () => {
    await player('clear');
    if (selected) Object.assign(selected, {count: 0, name: '', fileCount: 0, offset: 0});
    renderLoaded(null);
    message('Subtitles removed. The player’s original subtitle settings are restored.');
  }));

  run(null, async () => {
    await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
    const saved = await chrome.storage.local.get(['fontSize', 'subtitleLanguage', 'includeEnglish']);
    if (Array.from($('language').options).some(option => option.value === saved.subtitleLanguage)) $('language').value = saved.subtitleLanguage;
    if (typeof saved.includeEnglish === 'boolean') $('include-english').checked = saved.includeEnglish;
    languageNote();
    if (saved.fontSize) $('font-size').value = saved.fontSize;
    await detect();
  });
})();
