// ---------------------------------------------------------------------------
// Traitors — synthesized audio engine (Web Audio API, no external files)
// ---------------------------------------------------------------------------
// Everything here is generated in-browser with oscillators/noise buffers, so
// there's nothing to download and nothing that can 404. Audio only ever
// starts after the user taps the sound toggle (a real gesture), which keeps
// browsers' autoplay-blocking happy.

const TraitorsAudio = (() => {
  let ctx = null;
  let masterGain = null;
  let muted = true;
  let droneNodes = null; // { oscs, gain, lfo }
  let currentDroneMode = null; // 'calm' | 'tense' | null
  let desiredPhase = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.35;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return true;
  }

  function init() {
    const saved = localStorage.getItem("traitors_muted");
    muted = saved === null ? true : saved === "1";
  }

  function isMuted() { return muted; }

  function phaseToMode(phase) {
    if (phase === "NIGHT") return "tense";
    if (phase === "GAME_OVER") return null;
    return "calm";
  }

  function startDrone(mode) {
    if (!mode || currentDroneMode === mode) {
      if (!mode) stopDrone(0.8);
      return;
    }
    stopDrone(0.5);
    const now = ctx.currentTime;
    const freqs = mode === "tense" ? [55, 58.3] : [65.4, 82.4];
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(masterGain);
    const oscs = freqs.map((f) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(gain);
      o.start();
      return o;
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = mode === "tense" ? 0.55 : 0.15;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = mode === "tense" ? 0.035 : 0.015;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    lfo.start();
    gain.gain.linearRampToValueAtTime(mode === "tense" ? 0.12 : 0.07, now + 1.4);
    droneNodes = { oscs, gain, lfo };
    currentDroneMode = mode;
  }

  function stopDrone(fade) {
    if (!droneNodes) { currentDroneMode = null; return; }
    const now = ctx.currentTime;
    droneNodes.gain.gain.cancelScheduledValues(now);
    droneNodes.gain.gain.setValueAtTime(droneNodes.gain.gain.value, now);
    droneNodes.gain.gain.linearRampToValueAtTime(0, now + fade);
    const nodes = droneNodes;
    setTimeout(() => {
      nodes.oscs.forEach((o) => { try { o.stop(); } catch (e) {} });
      try { nodes.lfo.stop(); } catch (e) {}
    }, fade * 1000 + 150);
    droneNodes = null;
    currentDroneMode = null;
  }

  function setPhase(phase) {
    desiredPhase = phase;
    if (muted || !ctx) return;
    startDrone(phaseToMode(phase));
  }

  function setMuted(val) {
    muted = val;
    localStorage.setItem("traitors_muted", muted ? "1" : "0");
    if (!ctx) return;
    const now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(muted ? 0 : 0.35, now + 0.4);
    if (!muted) startDrone(phaseToMode(desiredPhase));
    else stopDrone(0.4);
  }

  function toggleMute() {
    if (!ensureCtx()) return muted;
    setMuted(!muted);
    return muted;
  }

  function blip(freq, duration, type, gainVal) {
    if (muted || !ensureCtx()) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(masterGain);
    o.start(now);
    g.gain.linearRampToValueAtTime(gainVal || 0.2, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    o.stop(now + duration + 0.05);
  }

  function chord(freqs, duration, type, gainVal) {
    if (muted || !ensureCtx()) return;
    const now = ctx.currentTime;
    freqs.forEach((f) => {
      const o = ctx.createOscillator();
      o.type = type || "sine";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(masterGain);
      o.start(now);
      g.gain.linearRampToValueAtTime(gainVal || 0.14, now + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      o.stop(now + duration + 0.1);
    });
  }

  function playVote() {
    blip(880, 0.12, "sine", 0.14);
  }

  function playKill() {
    if (muted || !ensureCtx()) return;
    const now = ctx.currentTime;
    [110, 116.5, 233].forEach((f) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(masterGain);
      o.start(now);
      g.gain.linearRampToValueAtTime(0.16, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
      o.stop(now + 1.4);
    });
    const bufferSize = Math.floor(ctx.sampleRate * 0.3);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const ng = ctx.createGain();
    ng.gain.value = 0.18;
    noise.connect(ng);
    ng.connect(masterGain);
    noise.start(now);
  }

  function playWin() {
    stopDrone(0.8);
    chord([261.6, 329.6, 392.0, 523.2], 2.2, "triangle", 0.11);
  }

  function playLose() {
    stopDrone(0.8);
    chord([220, 261.6, 311.1], 2.6, "sawtooth", 0.09);
  }

  return { init, toggleMute, isMuted, setPhase, playVote, playKill, playWin, playLose };
})();

window.TraitorsAudio = TraitorsAudio;