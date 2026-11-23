(() => {
  'use strict';
  const VERSION = '0.3.6';
  const DISPOSE_EVENT = 'subtitle-bridge-dispose';
  const previous = globalThis.SubtitleBridgePlayer;
  if (previous?.version === VERSION) return;
  document.dispatchEvent(new Event(DISPOSE_EVENT));
  if (previous?.dispose) previous.dispose();
  else if (previous) for (const entry of previous.status()) previous.clear(entry);
  const nodes = new Map();
  const sessions = new Map();
  const tracks = new WeakMap();
  let nextId = 0;

  function videos(root = document) {
    const found = Array.from(root.querySelectorAll('video'));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) found.push(...videos(element.shadowRoot));
    }
    return found;
  }

  // An extension reload creates a new isolated world, but older versions can
  // leave their DOM and event handlers alive. Keep retired hosts invisible
  // even when an old handler reattaches them on the next playback event.
  for (const host of document.querySelectorAll('[data-subtitle-bridge-overlay]')) {
    host.style.setProperty('display', 'none', 'important');
    host.style.setProperty('visibility', 'hidden', 'important');
    host.removeAttribute('data-subtitle-bridge-overlay');
    host.remove();
  }
  for (const video of videos()) {
    for (const track of video.textTracks) {
      if (!track.label.startsWith('Subtitle Bridge')) continue;
      track.mode = 'hidden';
      for (const cue of Array.from(track.cues || [])) track.removeCue(cue);
      track.mode = 'disabled';
    }
  }

  function status() {
    const live = videos();
    for (const [id, video] of nodes) {
      if (!live.includes(video)) { clear({id}); nodes.delete(id); }
    }
    return live.map(video => {
      let id = Array.from(nodes).find(([, node]) => node === video)?.[0];
      if (!id) { id = `sb-${++nextId}`; nodes.set(id, video); }
      const box = video.getBoundingClientRect();
      const state = sessions.get(id);
      return {id, area: box.width * box.height, playing: !video.paused,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        currentTime: video.currentTime, name: state?.name || '',
        count: state?.cues.length || 0, fileCount: state?.sources.length || 0, offset: state?.offset || 0,
        visible: state?.visible ?? true, fontSize: state?.fontSize || 24};
    });
  }

  function getVideo(id) {
    const video = nodes.get(id);
    if (!video?.isConnected) throw new Error('The player has changed. Click Detect again.');
    return video;
  }

  function restore(state, video) {
    for (const {track, mode} of state.originalTracks) {
      if (Array.from(video.textTracks).includes(track)) track.mode = mode;
    }
  }

  function render(state, video) {
    if (!video.isConnected) { clear({id: state.id}); return; }
    // Custom players can disable native tracks or hide ::cue. Draw captions in
    // our own shadow root; use the native track for a video-element fullscreen.
    const fullscreen = document.fullscreenElement;
    const native = fullscreen === video || document.pictureInPictureElement === video;
    const parent = fullscreen && fullscreen.contains(video) && !native ? fullscreen : document.documentElement;
    if (state.overlay.parentNode !== parent) parent.append(state.overlay);
    // Hidden tracks still expose activeCues to custom website renderers.
    // Disable them while our overlay is drawing to avoid duplicate captions.
    if (state.visible) for (const track of video.textTracks) {
      if (track !== state.track && track.mode !== 'disabled') track.mode = 'disabled';
    }
    const mode = state.visible && native ? 'showing' : 'disabled';
    if (state.track.mode !== mode) state.track.mode = mode;
    state.overlay.hidden = !state.visible || native;
    if (!state.visible || native) return;

    const box = video.getBoundingClientRect();
    for (const [property, value] of Object.entries({left: box.left, top: box.top, width: box.width, height: box.height})) {
      state.overlay.style.setProperty(property, `${value}px`, 'important');
    }
    let lo = 0, hi = state.shifted.length;
    const time = video.currentTime;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (state.shifted[mid].start <= time) lo = mid + 1; else hi = mid;
    }
    const active = [];
    for (let i = lo - 1; i >= 0 && state.maxEnd[i] > time; i--) {
      if (state.shifted[i].end > time) active.push(state.shifted[i]);
    }
    const caption = active.sort((a, b) => a.layer - b.layer || a.start - b.start).map(cue => cue.text).join('\n');
    if (state.caption.textContent !== caption) state.caption.textContent = caption;
    state.caption.hidden = !caption;
    state.caption.style.fontSize = `${state.fontSize}px`;
  }

  function overlay(state, video) {
    const host = document.createElement('div');
    host.setAttribute('data-subtitle-bridge-overlay', state.id);
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;display:block!important;pointer-events:none!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;';
    const shadow = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = ':host([hidden]){display:none!important}.position{position:absolute;left:4%;right:4%;bottom:8%;text-align:center;pointer-events:none}.caption{display:inline-block;max-width:100%;margin:0;padding:3px 9px;border-radius:4px;background:rgba(0,0,0,.78);color:#fff;font:600 24px/1.4 system-ui,sans-serif;white-space:pre-line;overflow-wrap:anywhere;text-align:center}.caption[hidden]{display:none}';
    const position = document.createElement('div'); position.className = 'position';
    const caption = document.createElement('span'); caption.className = 'caption';
    position.append(caption); shadow.append(style, position);
    state.overlay = host; state.caption = caption;
    const update = () => render(state, video);
    let frame;
    const tick = () => {
      update();
      if (sessions.get(state.id) === state && !video.paused && !video.ended) frame = requestAnimationFrame(tick);
    };
    const play = () => { cancelAnimationFrame(frame); tick(); };
    const stop = () => { cancelAnimationFrame(frame); update(); };
    const events = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'enterpictureinpicture', 'leavepictureinpicture'];
    for (const event of events) video.addEventListener(event, update);
    video.addEventListener('play', play); video.addEventListener('pause', stop); video.addEventListener('ended', stop);
    document.addEventListener('fullscreenchange', update);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update); observer.observe(video);
    state.dispose = () => {
      cancelAnimationFrame(frame); observer.disconnect();
      for (const event of events) video.removeEventListener(event, update);
      video.removeEventListener('play', play); video.removeEventListener('pause', stop); video.removeEventListener('ended', stop);
      document.removeEventListener('fullscreenchange', update);
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true);
      host.remove();
    };
    state.start = play;
  }

  function paint(state, video) {
    const text = globalThis.SubtitleBridge;
    state.shifted = text.shifted(state.cues, state.offset);
    let max = 0;
    state.maxEnd = state.shifted.map(cue => (max = Math.max(max, cue.end)));
    state.track.mode = 'hidden';
    for (const cue of Array.from(state.track.cues || [])) state.track.removeCue(cue);
    for (const item of state.shifted) {
      const escaped = item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cue = new VTTCue(item.start, item.end, escaped);
      cue.align = 'center';
      cue.size = 90;
      state.track.addCue(cue);
    }
    if (!state.visible) {
      state.track.mode = 'disabled';
      restore(state, video);
    }
    state.style.textContent = state.visible ? `video[data-subtitle-bridge="${state.id}"]::cue {font-size:${state.fontSize}px!important;color:#fff!important;visibility:visible!important;opacity:1!important;background:rgba(0,0,0,.78)!important;font-family:system-ui,sans-serif;}` : '';
    state.start();
  }

  function load({id, text, name, fontSize = 24, append = false, secondary = null}) {
    const video = getVideo(id);
    const cues = globalThis.SubtitleBridge.parse(text);
    const second = secondary ? {name: secondary.name, cues: globalThis.SubtitleBridge.parse(secondary.text)} : null;
    let state = sessions.get(id);
    if (append && !state) throw new Error('Load the first subtitle file, then use Add second.');
    if (append && state.sources[0].cues.length === cues.length && cues.every((cue, index) => {
      const first = state.sources[0].cues[index];
      return cue.start === first.start && cue.end === first.end && cue.text === first.text;
    })) throw new Error('This is the first subtitle file. Choose a different file to add.');
    if (!state) {
      const style = document.createElement('style');
      (video.getRootNode() instanceof ShadowRoot ? video.getRootNode() : document.head || document.documentElement).append(style);
      const originalTracks = Array.from(video.textTracks).map(track => ({track, mode: track.mode}));
      let track = tracks.get(video);
      if (!track) {
        track = video.addTextTrack('subtitles', 'Subtitle Bridge · External subtitles', 'und');
        tracks.set(video, track);
        video.addEventListener('emptied', () => clear({id: video.getAttribute('data-subtitle-bridge')}));
      }
      state = {id, track, style, originalTracks};
      sessions.set(id, state);
      video.setAttribute('data-subtitle-bridge', id);
      overlay(state, video);
    }
    // Add second replaces the secondary file, so repeated clicks never stack
    // an unlimited number of streams. A normal load replaces both files.
    const sources = append ? [state.sources[0], {name, cues}] : [{name, cues}, ...(second ? [second] : [])];
    const merged = sources.flatMap((source, layer) => source.cues.map(cue => ({...cue, layer})))
      .sort((a, b) => a.start - b.start || a.end - b.end || a.layer - b.layer);
    Object.assign(state, {sources, name: sources.map(source => source.name).join(' + '), cues: merged,
      offset: append ? state.offset : 0, visible: true, fontSize: Math.min(42, Math.max(16, Number(fontSize) || 24))});
    paint(state, video);
    return {count: state.cues.length, name: state.name, fileCount: sources.length, offset: state.offset};
  }

  function configure({id, offset, visible, fontSize}) {
    const video = getVideo(id);
    const state = sessions.get(id);
    if (!state?.cues.length) throw new Error('Load subtitles first.');
    if (offset !== undefined) {
      globalThis.SubtitleBridge.shifted([], offset);
      state.offset = offset;
    }
    if (visible !== undefined) state.visible = Boolean(visible);
    if (fontSize !== undefined) state.fontSize = Math.min(42, Math.max(16, Number(fontSize) || 24));
    paint(state, video);
    return {offset: state.offset, visible: state.visible, fontSize: state.fontSize};
  }

  function clear({id}) {
    const state = sessions.get(id);
    if (!state) return;
    const video = nodes.get(id);
    state.track.mode = 'hidden';
    for (const cue of Array.from(state.track.cues || [])) state.track.removeCue(cue);
    state.track.mode = 'disabled';
    if (video) { restore(state, video); video.removeAttribute('data-subtitle-bridge'); }
    state.style.remove();
    state.dispose();
    sessions.delete(id);
  }

  function dispose() {
    for (const id of Array.from(sessions.keys())) clear({id});
    document.removeEventListener(DISPOSE_EVENT, dispose);
  }
  document.addEventListener(DISPOSE_EVENT, dispose);
  globalThis.SubtitleBridgePlayer = {version: VERSION, status, load, configure, clear, dispose};
})();
