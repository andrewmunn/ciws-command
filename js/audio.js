// ---------------------------------------------------------------------------
// Procedural sound effects via the Web Audio API. No asset files — every sound
// is synthesized, so it works offline and stays tiny. Exposed as a singleton.
//
// Spatial flavour: most effects take an optional `pan` (-1..1, from the event's
// sim x position) routed through a StereoPanner, and big impacts send a portion
// of their signal into a generated-impulse convolver for a battlefield echo.
// A faint looping wind bed starts at unlock for ambience.
//
// AudioContext must be created/resumed after a user gesture, so call
// sfx.unlock() from the first pointer/key handler.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.reverb = null; // convolver send bus (null if unsupported)
    this.noiseBuffer = null;
    this.muted = false;
    this._lastFire = 0; // throttle clock for the gun stream
    this._lastDry = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = CONFIG.audio.masterVolume;
      // A limiter lets us run the master hot (loud) without harsh clipping when
      // several sounds overlap.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.noiseBuffer = this._makeNoise(0.5);
      this._buildReverb();
      this._startWind();
    } catch (e) {
      this.ctx = null; // audio simply disabled if unavailable
    }
  }

  /**
   * Faint looping wind bed for battlefield ambience: looped noise through a
   * slowly-wandering lowpass (an LFO drifts the cutoff so it breathes like
   * gusts rather than sitting on one static hiss). Runs for the whole session
   * at very low level; the mute toggle silences it with everything else.
   */
  _startWind() {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this._makeNoise(2.0);
      src.loop = true;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 240;
      filt.Q.value = 0.7;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.09; // a slow gust cycle
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 130; // cutoff wanders 110..370 Hz
      lfo.connect(lfoGain).connect(filt.frequency);
      const g = this.ctx.createGain();
      g.gain.value = 0.018;
      src.connect(filt).connect(g).connect(this.master);
      src.start();
      lfo.start();
    } catch (e) {
      // no wind — the battle still sounds fine
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.value = this.muted ? 0 : CONFIG.audio.masterVolume;
    }
    return this.muted;
  }

  get ready() {
    return this.ctx && !this.muted;
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Stereo exponentially-decaying noise burst = a cheap, convincing impulse. */
  _buildReverb() {
    try {
      const A = CONFIG.audio;
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * A.reverbSeconds);
      const ir = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, A.reverbDecay);
        }
      }
      const conv = this.ctx.createConvolver();
      conv.buffer = ir;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.5;
      conv.connect(wet).connect(this.master);
      this.reverb = conv;
    } catch (e) {
      this.reverb = null;
    }
  }

  /**
   * Output chain for one voice: gain -> [stereo pan] -> master, with an
   * optional parallel send into the reverb bus. Returns the entry node.
   */
  _route(g, pan = 0, verb = 0) {
    let node = g;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan * CONFIG.audio.panWidth));
      node.connect(p);
      node = p;
    }
    node.connect(this.master);
    if (verb > 0 && this.reverb) {
      const send = this.ctx.createGain();
      send.gain.value = verb;
      g.connect(send).connect(this.reverb);
    }
    return g;
  }

  // --- low-level builders --------------------------------------------------
  _noise(dur, gain, filterType, freqStart, freqEnd, opts = {}) {
    const t = this.ctx.currentTime + (opts.delay || 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3; // subtle per-shot variation
    const filt = this.ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.setValueAtTime(freqStart, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(this._route(g, opts.pan, opts.verb));
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  _tone(freqStart, freqEnd, dur, gain, type = 'sine', delay = 0, opts = {}) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(this._route(g, opts.pan, opts.verb));
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A few short delayed noise blips that read as secondary debris crackle. */
  _crackle(pan, base = 0.05) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this._noise(0.05 + Math.random() * 0.06, base + Math.random() * 0.05, 'bandpass',
        1400 + Math.random() * 1800, 500, {
          pan: pan + (Math.random() - 0.5) * 0.3,
          delay: 0.12 + Math.random() * 0.45,
          verb: 0.2,
        });
    }
  }

  // --- game sounds ---------------------------------------------------------

  /**
   * One CIWS round, GAU-8 "BRRRT" flavour: a short low-passed noise body plus a
   * gritty low square thump. Played per round, the ~50/s repetition fuses into
   * the characteristic Warthog buzzsaw. Barely throttled so the buzz holds.
   */
  fire(pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t - this._lastFire < 0.009) return; // safety cap (~110/s)
    this._lastFire = t;

    // Low noise body.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(950 + Math.random() * 350, t);
    filt.frequency.exponentialRampToValueAtTime(300, t + 0.04);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(filt).connect(this._route(g, pan));
    src.start(t);
    src.stop(t + 0.07);

    // Gritty low-end thump for the roar.
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(82 + Math.random() * 14, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.045);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.12, t + 0.003);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    osc.connect(this._route(g2, pan));
    osc.start(t);
    osc.stop(t + 0.065);

    // Mechanical action snap: a 6ms high-passed click on top. This transient
    // is what makes each report read as a cannon instead of an arcade blip.
    const snap = this.ctx.createBufferSource();
    snap.buffer = this.noiseBuffer;
    const sf = this.ctx.createBiquadFilter();
    sf.type = 'highpass';
    sf.frequency.value = 2600;
    const g3 = this.ctx.createGain();
    g3.gain.setValueAtTime(0.09, t);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    snap.connect(sf).connect(this._route(g3, pan));
    snap.start(t);
    snap.stop(t + 0.02);
  }

  /** Dry click when firing an empty gun. */
  dryFire() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastDry < 0.12) return;
    this._lastDry = now;
    this._noise(0.03, 0.04, 'highpass', 3000, 2000);
  }

  /**
   * A threat is destroyed mid-air. Each enemy type has its own signature:
   *   normal     — punchy warhead pop.
   *   evasive    — warbling spin-down whine (its guidance dying) + burst.
   *   hypersonic — supersonic crack, then the scream falls away.
   *   mirv       — armoured bus: metallic clang and a heavy double thump.
   *   cruise     — turbine whine dying + fuel-tank whump.
   *   drone      — electric fizzle and a sad little pop.
   *   bomber     — a big airframe coming apart: deep whump, dying engine
   *                groan falling away, long debris crackle.
   *   nuke       — the carcass blows big and hollow (no chain reaction).
   */
  kill(type = 'normal', pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.3 };
    if (type === 'cruise') {
      this._warble(620, 90, 0.3, 0.16, pan); // turbine spooling down
      this._noise(0.28, 0.38, 'lowpass', 1800, 240, { pan, verb: 0.4 }); // fuel whump
      this._tone(300, 90, 0.25, 0.26, 'triangle', 0.03, o);
      this._crackle(pan, 0.05);
    } else if (type === 'drone') {
      this._noise(0.12, 0.22, 'highpass', 5200, 2400, o); // electric sizzle
      this._tone(880, 110, 0.22, 0.16, 'square', 0, o); // power dying
      this._tone(240, 140, 0.08, 0.14, 'triangle', 0.05, o); // pop
    } else if (type === 'nuke') {
      this._noise(0.06, 0.34, 'highpass', 4800, 2800, o); // casing crack
      this._noise(0.55, 0.46, 'lowpass', 1700, 120, { pan, verb: 0.5 });
      this._tone(170, 36, 0.6, 0.46, 'sine', 0, o); // big hollow boom
      this._crackle(pan, 0.08);
    } else if (type === 'mirv') {
      this._tone(950, 300, 0.1, 0.18, 'square', 0, o); // armour clang
      this._noise(0.4, 0.42, 'lowpass', 1600, 180, { pan, verb: 0.45 });
      this._tone(190, 48, 0.5, 0.42, 'sine', 0, o); // main thump
      this._tone(150, 38, 0.45, 0.3, 'sine', 0.13, o); // secondary cook-off
      this._crackle(pan, 0.07);
    } else if (type === 'bomber') {
      this._noise(0.06, 0.32, 'highpass', 4600, 2600, o); // structural crack
      this._noise(0.5, 0.44, 'lowpass', 1500, 140, { pan, verb: 0.5 }); // fuel whump
      this._tone(180, 42, 0.55, 0.4, 'sine', 0, o); // heavy main thump
      this._warble(360, 60, 0.7, 0.2, pan); // engines groaning down
      this._crackle(pan, 0.09);
      this._crackle(pan, 0.06); // a long shower of burning debris
    } else if (type === 'evasive') {
      this._warble(900, 180, 0.38, 0.2, pan); // guidance whine spins down
      this._noise(0.16, 0.3, 'bandpass', 1600, 420, o);
      this._tone(420, 150, 0.18, 0.2, 'triangle', 0.04, o);
    } else if (type === 'hypersonic') {
      this._noise(0.05, 0.45, 'highpass', 6500, 3500, o); // sonic crack
      this._tone(3100, 420, 0.4, 0.13, 'sine', 0.03, o); // scream falls away
      this._noise(0.25, 0.22, 'lowpass', 2200, 320, o);
    } else {
      // Plain warhead pop, weighted toward the low end for a real thud.
      this._noise(0.05, 0.22, 'highpass', 4200, 2600, o); // initial crack
      this._noise(0.18, 0.36, 'lowpass', 1600, 300, o);
      this._tone(320, 90, 0.2, 0.3, 'triangle', 0, o);
      this._tone(110, 45, 0.28, 0.2, 'sine', 0.02, o); // sub weight
      this._crackle(pan, 0.03);
    }
  }

  /** Sawtooth sweep with an LFO wobbling its pitch — a sick, dying whine. */
  _warble(freqStart, freqEnd, dur, gain, pan = 0) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.setValueAtTime(28, t);
    lfo.frequency.linearRampToValueAtTime(9, t + dur); // wobble slows as it dies
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = freqStart * 0.18;
    lfo.connect(lfoGain).connect(osc.frequency);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(this._route(g, pan, 0.25));
    osc.start(t);
    osc.stop(t + dur + 0.02);
    lfo.start(t);
    lfo.stop(t + dur + 0.02);
  }

  /** A round hits an armoured target but doesn't destroy it (metallic ting). */
  hit(pan = 0) {
    if (!this.ready) return;
    this._noise(0.05, 0.08, 'bandpass', 3200, 2600, { pan });
    this._tone(1500, 1100, 0.06, 0.06, 'square', 0, { pan });
  }

  /** Sustained rocket-engine burn for an interceptor's boost phase. */
  rocketBurn(dur = 0.5, pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    // Rumbly exhaust: looping noise through a lowpass — ignition, burn, cutoff.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(500, t);
    filt.frequency.linearRampToValueAtTime(950, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.05); // ignition
    g.gain.setValueAtTime(0.3, t + Math.max(0.06, dur - 0.1)); // sustained burn
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur); // burnout
    src.connect(filt).connect(this._route(g, pan, 0.25));
    src.start(t);
    src.stop(t + dur + 0.03);
    // Low engine tone that rises as thrust builds.
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.linearRampToValueAtTime(120, t + dur);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.2, t + 0.06);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(this._route(g2, pan));
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /** A hypersonic streaks in: a descending high-pitched scream + sizzle. */
  hypersonicLaunch(pan = 0) {
    if (!this.ready) return;
    this._tone(2700, 680, 0.55, 0.16, 'sawtooth', 0, { pan, verb: 0.3 });
    this._noise(0.55, 0.1, 'highpass', 4200, 1800, { pan });
  }

  /**
   * Interceptor warhead detonation (punchy area burst). `small` is the AAM's
   * lighter warhead: same character, less weight, no debris crackle.
   */
  interceptorBoom(pan = 0, small = false) {
    if (!this.ready) return;
    const k = small ? 0.6 : 1;
    const o = { pan, verb: small ? 0.3 : 0.4 };
    this._noise(0.04, 0.3 * k, 'highpass', 5200, 3200, o); // initial crack
    this._noise(0.3 * k, 0.32 * k, 'lowpass', 2200, 300, o);
    this._tone(260, 70, 0.3 * k, 0.3 * k, 'triangle', 0, o);
    this._tone(90, 34, 0.5 * k, 0.26 * k, 'sine', 0.02, o); // sub thump
    if (!small) this._crackle(pan);
  }

  /**
   * The airstrike arrives: a flight of jets sweeping across the field. A long
   * turbine roar whose pan tracks the pass direction (the closest thing to a
   * doppler flyby a synth can cheaply sell), with an afterburner low end.
   */
  airstrike(dir = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 2.6;
    // Turbine roar body, swelling in and fading as the flight exits.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 1.1;
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.exponentialRampToValueAtTime(900, t + dur * 0.45); // approach
    filt.frequency.exponentialRampToValueAtTime(260, t + dur); // receding
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      const w = CONFIG.audio.panWidth;
      p.pan.setValueAtTime(-dir * w, t); // enters from the launch side...
      p.pan.linearRampToValueAtTime(dir * w, t + dur); // ...and crosses over
      g.connect(p);
      node = p;
    }
    node.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = 0.3;
    if (this.reverb) g.connect(send).connect(this.reverb);
    src.connect(filt).connect(g);
    src.start(t);
    src.stop(t + dur + 0.05);
    // Afterburner low end under the roar.
    this._tone(70, 130, dur * 0.5, 0.16, 'sawtooth', 0.2);
    this._tone(130, 55, dur * 0.5, 0.14, 'sawtooth', 0.2 + dur * 0.5);
  }

  /**
   * The flight arrives supersonic: a hard double crack — the bow and tail
   * shocks of the N-wave — followed by a rolling rumble off the terrain.
   */
  sonicBoom(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.5 };
    this._noise(0.045, 0.5, 'lowpass', 3200, 700, o); // bow shock crack
    this._noise(0.045, 0.42, 'lowpass', 2800, 600, { pan, verb: 0.5, delay: 0.07 }); // tail shock
    this._tone(95, 30, 0.5, 0.4, 'sine', 0.02, o); // body of the boom
    this._noise(0.7, 0.18, 'lowpass', 700, 90, { pan, verb: 0.6, delay: 0.12 }); // rolling rumble
  }

  /** An AAM snaps off the rail: a short, sharp motor whoosh. */
  aamLaunch(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.2 };
    this._noise(0.3, 0.22, 'bandpass', 1400, 3400, o); // motor lighting up
    this._tone(420, 1300, 0.22, 0.1, 'sawtooth', 0, o); // rising as it departs
  }

  /** A MIRV nuke bus splits: a hard pyro clunk, then three quick releases. */
  mirvSeparation(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.35 };
    this._tone(300, 90, 0.12, 0.3, 'square', 0, o); // separation charge
    this._noise(0.18, 0.26, 'lowpass', 1600, 300, o);
    for (let i = 0; i < 3; i++) {
      this._noise(0.08, 0.14, 'bandpass', 2200, 900, {
        pan: pan + (i - 1) * 0.15,
        delay: 0.16 + i * 0.09, // one whoosh per warhead fanning out
      });
    }
  }

  /** Tried to launch with no lock / no interceptors left, or can't afford. */
  denied() {
    if (!this.ready) return;
    this._tone(300, 200, 0.1, 0.12, 'square');
  }

  /** A shield takes a hit and collapses — energy spike then power-down + shatter. */
  shieldBreak(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.35 };
    this._tone(700, 1500, 0.08, 0.22, 'sine', 0, o); // energy spike up
    this._tone(1500, 180, 0.45, 0.32, 'sawtooth', 0, o); // power-down sweep
    this._noise(0.4, 0.3, 'bandpass', 3200, 500, o); // shatter/sizzle
  }

  /** A glide bomb separates and noses over: the classic falling whistle. */
  bombDrop(pan = 0) {
    if (!this.ready) return;
    this._tone(1500, 320, 1.3, 0.07, 'sine', 0, { pan, verb: 0.3 });
    this._tone(1508, 327, 1.3, 0.05, 'sine', 0, { pan }); // beat-frequency flutter
  }

  /** Flare burst: pyrotechnic dispenser thunks, then a magnesium-bright hiss. */
  flare(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.25 };
    this._tone(220, 90, 0.07, 0.16, 'square', 0, o); // dispenser thunk
    this._tone(240, 100, 0.07, 0.12, 'square', 0.08, o); // second round out
    this._noise(0.9, 0.1, 'highpass', 5200, 3200, o); // burning-bright sizzle
  }

  /** Laser shot: a charged zap — bright descending beam tone over a sizzle. */
  laser(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.2 };
    this._tone(2400, 220, 0.18, 0.2, 'sawtooth', 0, o); // beam zap
    this._tone(3600, 900, 0.1, 0.1, 'sine', 0, o); // bright edge
    this._noise(0.16, 0.12, 'highpass', 6000, 2600, o); // ionized sizzle
    this._tone(140, 60, 0.08, 0.14, 'square', 0, o); // capacitor thunk
  }

  /**
   * Synthetic-voice announcement via the Web Speech API (no assets needed).
   * Low pitch for an ominous command-bunker delivery. Safe no-op when speech
   * is unavailable; honours the mute toggle.
   */
  say(text) {
    if (this.muted) return;
    try {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const u = new window.SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.pitch = 0.45;
      u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) {
      // speech unavailable — fine, the klaxon still warns
    }
  }

  /** Incoming-nuke klaxon: an urgent, unmissable two-tone warning. */
  alarm(pan = 0) {
    if (!this.ready) return;
    for (let i = 0; i < 4; i++) {
      const d = i * 0.32;
      this._tone(760, 760, 0.15, 0.28, 'square', d, { pan });
      this._tone(508, 508, 0.15, 0.28, 'square', d + 0.16, { pan });
      // Sub-octave layer so it cuts through the battle noise.
      this._tone(380, 380, 0.15, 0.18, 'sawtooth', d, { pan });
    }
  }

  /** A nuke reached the ground: an enormous, long detonation. */
  nukeBlast(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.7 };
    this._noise(0.08, 0.5, 'highpass', 6000, 3000, o); // searing crack
    this._noise(1.6, 0.6, 'lowpass', 2400, 60, o); // huge pressure wave
    this._tone(120, 24, 1.8, 0.6, 'sine', 0, o); // ground-shaking sub
    this._tone(60, 20, 2.2, 0.4, 'triangle', 0.15, o); // rolling rumble
    this._noise(1.2, 0.25, 'bandpass', 900, 200, { pan, verb: 0.6, delay: 0.5 }); // debris roar
    this._crackle(pan, 0.12);
    this._crackle(pan, 0.1);
  }

  /** Shop purchase confirmation (rising two-note chime). */
  buy() {
    if (!this.ready) return;
    this._tone(660, 660, 0.1, 0.14, 'triangle');
    this._tone(990, 990, 0.12, 0.12, 'triangle', 0.08);
  }

  /** A warhead hits bare ground (lands harmlessly): dull earthen whump. */
  groundImpact(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.4 };
    this._noise(0.4, 0.4, 'lowpass', 900, 120, o);
    this._tone(150, 42, 0.45, 0.5, 'sine', 0, o);
    this._crackle(pan, 0.03);
  }

  /** A warhead destroys a city/turret — a bigger, layered explosion. */
  targetHit(pan = 0) {
    if (!this.ready) return;
    const o = { pan, verb: 0.55 };
    this._noise(0.06, 0.3, 'highpass', 5000, 3000, o); // sharp initial crack
    this._noise(0.6, 0.5, 'lowpass', 2000, 110, o); // debris body
    this._tone(200, 38, 0.65, 0.55, 'sine', 0, o); // deep boom
    this._tone(95, 30, 0.7, 0.3, 'triangle', 0.05, o); // sub rumble
    this._crackle(pan, 0.08);
  }

  waveClear() {
    if (!this.ready) return;
    [523, 659, 784].forEach((f, i) =>
      this._tone(f, f, 0.18, 0.16, 'triangle', i * 0.12)
    );
  }

  gameOver() {
    if (!this.ready) return;
    [392, 311, 233, 165].forEach((f, i) =>
      this._tone(f, f * 0.9, 0.3, 0.22, 'sawtooth', i * 0.16)
    );
  }
}

export const sfx = new Sfx();
