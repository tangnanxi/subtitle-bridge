(function (root) {
  'use strict';
  const LIMIT = 4 * 1024 * 1024;

  function timestamp(value) {
    const match = String(value).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (!match) return NaN;
    const [, hours = '0', minutes, seconds, fraction = '0'] = match;
    if (+seconds > 59 || (match[1] !== undefined && +minutes > 59)) return NaN;
    return +hours * 3600 + +minutes * 60 + +seconds + +(fraction.padEnd(3, '0')) / 1000;
  }

  function plain(value) {
    return value.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '')
      .replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) =>
        ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '})[entity]).trim();
  }

  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > LIMIT) throw new Error('This file exceeds 4 MB. Choose a smaller text subtitle file.');
    if ((bytes[0] === 0x50 && bytes[1] === 0x4b) ||
        (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72) ||
        (bytes[0] === 0x37 && bytes[1] === 0x7a)) {
      throw new Error('This is an archive. Extract it first, then import an SRT, VTT or ASS file.');
    }
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    try { return new TextDecoder(encoding, {fatal: true}).decode(bytes); }
    catch { return new TextDecoder('gb18030', {fatal: true}).decode(bytes); }
  }

  function parse(text) {
    if (typeof text !== 'string' || text.length > LIMIT) throw new Error('Subtitle content is invalid or exceeds 4 MB.');
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    function add(start, end, value) {
      const content = plain(value);
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && content) {
        cues.push({start, end, text: content});
      }
    }
    if (/^\s*\[Events\]/mi.test(normalized)) {
      let active = false;
      let fields = [];
      for (const line of normalized.split('\n')) {
        if (/^\s*\[/.test(line)) active = /^\s*\[Events\]/i.test(line);
        if (!active) continue;
        if (/^Format:/i.test(line)) fields = line.slice(line.indexOf(':') + 1).split(',').map(v => v.trim().toLowerCase());
        if (!/^Dialogue:/i.test(line)) continue;
        if (!fields.length) fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
        if (fields.at(-1) !== 'text') throw new Error('This ASS event format is not supported. Convert the file to SRT.');
        const values = line.slice(line.indexOf(':') + 1).split(',');
        const content = values.slice(fields.length - 1).join(',');
        if (/\{[^}]*\\p[1-9]/.test(content)) continue;
        add(timestamp(values[fields.indexOf('start')]), timestamp(values[fields.indexOf('end')]), content);
      }
    } else {
      for (const block of normalized.split(/\n[\t ]*\n/)) {
        const lines = block.trim().split('\n');
        const at = lines.findIndex(line => line.includes('-->'));
        if (at < 0) continue;
        const match = lines[at].match(/^\s*(\S+)\s+-->\s+(\S+)/);
        if (match) add(timestamp(match[1]), timestamp(match[2]), lines.slice(at + 1).join('\n'));
      }
    }
    if (!cues.length) throw new Error('No valid subtitles found. Choose an SRT, VTT or ASS file with timestamps.');
    if (cues.length > 30000) throw new Error('Too many cues. Split the subtitles into individual movies or episodes.');
    return cues.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function shifted(cues, offset) {
    if (!Number.isFinite(offset) || Math.abs(offset) > 3600) throw new Error('Timing offset must be between −3600 and +3600 seconds.');
    return cues.map(cue => ({...cue, start: Math.max(0, cue.start + offset), end: cue.end + offset}))
      .filter(cue => cue.end > cue.start);
  }

  function hasEnglish(cues) {
    const primary = cues.filter(cue => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cue.text));
    const english = cues.filter(cue => cue.text.split('\n').some(line => {
      const words = line.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || [];
      return words.length >= 3 && words.join('').length >= 10;
    }));
    if (!primary.length || !english.length) return false;
    // Check dialogue overlap across the file, including ASS files that put
    // the two languages in separate simultaneous events. Credits are not enough.
    const sample = primary.filter((_, index) => index % Math.max(1, Math.ceil(primary.length / 40)) === 0);
    const paired = sample.filter(cue => english.some(other =>
      Math.min(cue.end, other.end) - Math.max(cue.start, other.start) >= Math.min(cue.end - cue.start, other.end - other.start) * .5));
    return paired.length >= Math.ceil(sample.length * .6);
  }

  function englishCandidates(rows, primary) {
    const ignored = new Set('srt ass ssa vtt chs cht eng en zh zt ja ko chinese english simplified traditional sub subs sdh hi retail 720p 1080p 2160p 480p 4k bluray blu ray brrip bdrip dvdrip dvd web dl webdl webrip x264 x265 h264 h265 xvid divx ac3 dts aac truehd atmos remux hdr hevc avc'.split(' '));
    const tokens = name => new Set(String(name).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !ignored.has(word) && !/^\d+$/.test(word)));
    const selected = tokens(primary.name);
    const family = name => String(name).toLowerCase().match(/blu[ ._-]?ray|web|dvd|r5/)?.[0].replace(/[ ._-]/g, '') || '';
    const score = row => [...tokens(row.name)].filter(token => selected.has(token)).length * 20
      + (family(primary.name) && family(primary.name) === family(row.name) ? 12 : 0);
    return rows.filter(row => row.languageCode === 'en' && !row.bilingualHint && row.url !== primary.url
      && !/commentary/i.test(row.name)
      && !(primary.fps && row.fps && Math.abs(Number(primary.fps) - Number(row.fps)) > .1))
      .map(row => ({row, score: score(row)})).sort((a, b) => b.score - a.score).map(item => item.row);
  }

  function similarDuration(first, second) {
    const end = cues => cues.reduce((maximum, cue) => Math.max(maximum, cue.end), 0);
    const duration = end(first);
    return Math.abs(duration - end(second)) <= Math.max(30, duration * .01);
  }

  const api = {parse, decode, shifted, timestamp, hasEnglish, englishCandidates, similarDuration, LIMIT};
  root.SubtitleBridge = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
