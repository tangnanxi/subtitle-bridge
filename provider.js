(function (root) {
  'use strict';
  const API = 'https://api.thesubtitledb.org';
  const CLIENT = 'subtitle-bridge/0.3.7';
  const languages = {
    zh: 'Simplified Chinese', zt: 'Traditional Chinese', en: 'English',
    es: 'Spanish', sp: 'Spanish (Spain)', ea: 'Spanish (Latin America)',
    pt: 'Portuguese', pb: 'Portuguese (Brazil)',
    fr: 'French', de: 'German', it: 'Italian', ja: 'Japanese', ko: 'Korean',
    ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian',
    ms: 'Malay', vi: 'Vietnamese', th: 'Thai', tr: 'Turkish', nl: 'Dutch',
    pl: 'Polish', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
    el: 'Greek', he: 'Hebrew', fa: 'Persian', ro: 'Romanian'
  };

  function safeDownload(address) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || !/(^|\.)thesubtitledb\.org$/i.test(url.hostname) || url.username || url.password || url.port) {
      throw new Error('This download address is not supported. Search for subtitles again.');
    }
    return url;
  }

  async function readBytes(response, limit) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The subtitle source returned an empty response. Try again.');
    const chunks = [];
    let length = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error('The response is too large. Choose another subtitle file.'); }
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
    return all.buffer;
  }

  async function search(query, language = 'zh,zt', includeEnglish = false) {
    query = String(query).trim();
    if (!query) throw new Error('Enter a movie or series title, or an IMDb ID.');
    if (typeof language !== 'string' || (language !== '' && (language.split(',').length > 16 || !language.split(',').every(code => Object.hasOwn(languages, code)))) || typeof includeEnglish !== 'boolean') throw new Error('Choose a supported subtitle language.');
    const paired = includeEnglish && Boolean(language) && language !== 'en';
    if (paired) {
      // A combined API filter can fill the result limit with English and omit
      // every primary-language file. Give each language its own result budget.
      const [primary, english] = await Promise.allSettled([search(query, language), search(query, 'en')]);
      if (primary.status === 'rejected' && english.status === 'rejected') throw primary.reason;
      if (primary.status === 'rejected') return {...english.value, notice: 'The selected-language lookup failed. Showing English results only.'};
      if (english.status === 'rejected') return {...primary.value, notice: 'English lookup failed. Showing selected-language results only.'};
      if (primary.value.title && english.value.title && primary.value.title !== english.value.title) {
        return {...primary.value, notice: 'The English lookup matched a different title. Showing selected-language results only.'};
      }
      const seen = new Set();
      const selectedCodes = new Set(language.split(','));
      const rows = [...primary.value.rows, ...english.value.rows].filter(row => {
        if (seen.has(row.url)) return false;
        seen.add(row.url); return true;
      }).sort((a, b) => Number(!selectedCodes.has(a.languageCode)) - Number(!selectedCodes.has(b.languageCode))
        || Number(b.bilingualHint) - Number(a.bilingualHint));
      return {title: primary.value.title || english.value.title, rows, total: primary.value.total + english.value.total};
    }
    const episode = query.match(/\bS(\d{1,3})\s*E(\d{1,3})\b/i);
    const titleQuery = (episode ? query.replace(episode[0], '') : query).trim();
    if (!titleQuery) throw new Error('Add the series title before the episode number.');
    const imdb = titleQuery.match(/^tt\d{5,12}$/i);
    let pathname = imdb ? `/v1/by-imdb/${titleQuery.toLowerCase()}` : '/v1/by-title';
    if (episode) pathname += `/season/${Number(episode[1])}/episode/${Number(episode[2])}`;
    const url = new URL(API + pathname);
    if (!imdb) url.searchParams.set('q', titleQuery);
    if (language) url.searchParams.set('lang', language);
    url.searchParams.set('limit', '40');
    url.searchParams.set('client', CLIENT);
    const response = await fetch(url, {signal: AbortSignal.timeout(15000), credentials: 'omit'});
    if (response.status === 404) return {title: '', rows: [], total: 0};
    if (response.status === 429) throw new Error('The subtitle source is rate limiting requests. Try again later.');
    if (!response.ok) throw new Error(`The subtitle source is unavailable (HTTP ${response.status}). Try again later or import a file.`);
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await readBytes(response, 2 * 1024 * 1024))); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('The subtitle source returned invalid data. Try again later.'); throw error; }
    const matchedTitle = [data.title?.name, data.title?.year].filter(Boolean).join(' · ');
    const selectedCodes = new Set(language.split(','));
    const rows = (Array.isArray(data.subtitles?.items) ? data.subtitles.items : []).filter(item =>
      /^(srt|vtt|ass|ssa)$/i.test(item.format || '') && typeof item.download_url === 'string'
      && (!language || selectedCodes.has(item.language))
    ).flatMap(item => {
      try { safeDownload(item.download_url); } catch { return []; }
      const name = item.release_name || matchedTitle || `Subtitle ${item.id}`;
      return [{id: item.id, name, fileName: /\.(srt|vtt|ass|ssa)$/i.test(name) ? name : `${name}.${item.format}`,
        language: languages[item.language] || item.language || 'Language unspecified', format: item.format.toUpperCase(),
        languageCode: item.language || '',
        bilingualHint: /中英|英中|双语|雙語|简英|簡英|繁英|日英|英日|韩英|韓英|英韩|英韓|bilingual|dual[ ._-]?(?:sub|lang)|(?:chs|cht|zh|chi|chinese|ja|jpn|japanese|ko|kor|korean)[ ._&+/-]+(?:eng?|english)|(?:eng?|english)[ ._&+/-]+(?:chs|cht|zh|chi|chinese|ja|jpn|japanese|ko|kor|korean)/i.test(name),
        url: item.download_url, fps: item.fps || null}];
    });
    return {title: matchedTitle, rows, total: data.subtitles?.total || 0};
  }

  async function download(address) {
    const url = safeDownload(address);
    url.searchParams.set('client', CLIENT);
    const response = await fetch(url, {signal: AbortSignal.timeout(20000), credentials: 'omit'});
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). Try again or choose another file.`);
    if (response.url) safeDownload(response.url);
    const text = root.SubtitleBridge.decode(await readBytes(response, root.SubtitleBridge.LIMIT));
    // Refuse error pages and empty responses before attaching anything to the video.
    root.SubtitleBridge.parse(text);
    return text;
  }

  root.SubtitleSource = {search, download};
  if (typeof module !== 'undefined') module.exports = root.SubtitleSource;
})(globalThis);
