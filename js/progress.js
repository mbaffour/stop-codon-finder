/*
 * progress.js -- ScanProgress: a monotonic, cost-model progress controller for
 * Stop Codon Finder. Pure logic (only touches localStorage, guarded). NO
 * network, no DOM.
 *
 * Exposes a global `ScanProgress`:
 *   ScanProgress.begin({fileBytes,textChars,totalBases})
 *   ScanProgress.enter(phaseId, totalUnits)      // phaseId in read|parse|scan|annot|summ|render
 *   ScanProgress.report(phaseId, doneUnits [,extra])
 *   ScanProgress.rescaleTail(actualHits)         // once, at scan->annot handoff
 *   ScanProgress.finish()                        // forces 100, stops clock
 *   ScanProgress.cancel(); ScanProgress.isCancelled() -> bool
 *   ScanProgress.onUpdate(cb)   // cb({percentInt,phaseLabel,elapsedMs,throughputText,etaText,indeterminate})
 *   ScanProgress.yield(cb)      // shared MessageChannel yield (delegates to CodonScanner.makeYield())
 *
 * Percent is monotonic (never decreases) and capped at 99 until the final
 * render report reaches its total, which is the only call permitted to hit 100.
 */
(function (global) {
  'use strict';

  var PHASES = ['read', 'parse', 'scan', 'annot', 'summ', 'render'];
  var LABELS = {
    read: 'Reading file…',
    parse: 'Parsing sequences & annotation…',
    scan: 'Scanning six reading frames…',
    annot: 'Classifying against annotation…',
    summ: 'Summarizing results…',
    render: 'Rendering results…'
  };

  // Default relative time-per-unit weights (calibrated & persisted below).
  // scan's unit is now a single codon-check (~6 per base); its per-unit weight
  // is 1/3 of the old per-2-bases weight so the scan phase keeps roughly the
  // same share of the cost model.
  var DEFAULT_PERUNIT = {
    read: 0.0005, parse: 0.0008, scan: 0.0003, annot: 0.004, summ: 0.0006, render: 0.02
  };
  var HIT_DENSITY = 0.05;       // rough stops-per-base estimate for pre-count
  var MAX_RENDER_ROWS = 5000;
  var EMA_ALPHA = 0.15;
  var WARMUP_MS = 350;
  var TRIVIAL_UNIT_THRESHOLD = 60000; // total scan bases below which we fast-path
  var PERF_KEY = 'scf-perf-v2'; // v2: scan unit changed to per-codon-check

  var state = null;
  var updateCbs = [];

  function loadPerf() {
    var perf = {};
    for (var k in DEFAULT_PERUNIT) perf[k] = DEFAULT_PERUNIT[k];
    try {
      var raw = global.localStorage.getItem(PERF_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        for (var p in obj) if (typeof obj[p] === 'number' && obj[p] > 0) perf[p] = obj[p];
      }
    } catch (e) { /* localStorage unavailable (some file:// contexts) */ }
    return perf;
  }

  function savePerf(perf) {
    try { global.localStorage.setItem(PERF_KEY, JSON.stringify(perf)); } catch (e) { /* ignore */ }
  }

  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function begin(info) {
    info = info || {};
    var perf = loadPerf();
    var fileBytes = info.fileBytes || 0;
    var textChars = info.textChars || fileBytes || 0;
    var totalBases = info.totalBases || 0;

    var estHits = Math.max(1, Math.round(totalBases * HIT_DENSITY));
    var estUnits = {
      read: Math.max(1, fileBytes),
      parse: Math.max(1, textChars),
      scan: Math.max(1, totalBases * 6),
      annot: estHits,
      summ: estHits,
      render: Math.min(estHits, MAX_RENDER_ROWS)
    };

    state = {
      perf: perf,
      startTime: now(),
      estUnits: estUnits,
      doneUnits: { read: 0, parse: 0, scan: 0, annot: 0, summ: 0, render: 0 },
      totalUnits: {},                 // set as phases are entered
      finished: {},                   // phase -> true when complete
      current: null,
      floorPercent: 0,
      cancelled: false,
      done: false,
      rescaled: false,
      trivial: totalBases > 0 && totalBases < TRIVIAL_UNIT_THRESHOLD,
      ema: {},                        // phase -> units/ms EMA
      phaseStart: {},                 // phase -> start time
      lastReport: {}                  // phase -> {t, units}
    };
    for (var i = 0; i < PHASES.length; i++) state.totalUnits[PHASES[i]] = estUnits[PHASES[i]];

    emit();
  }

  function phaseCost(phase, units) {
    return units * (state.perf[phase] || DEFAULT_PERUNIT[phase]);
  }

  function totalCost() {
    var sum = 0;
    for (var i = 0; i < PHASES.length; i++) {
      sum += phaseCost(PHASES[i], state.totalUnits[PHASES[i]]);
    }
    return sum || 1;
  }

  function enter(phaseId, totalUnits) {
    if (!state) return;
    if (state.current && state.current !== phaseId) {
      // finishing the previous phase implicitly.
      completePhase(state.current);
    }
    state.current = phaseId;
    if (typeof totalUnits === 'number' && totalUnits >= 0) {
      state.totalUnits[phaseId] = Math.max(1, totalUnits);
    }
    if (!state.phaseStart[phaseId]) state.phaseStart[phaseId] = now();
    state.lastReport[phaseId] = { t: now(), units: state.doneUnits[phaseId] || 0 };
    emit();
  }

  function completePhase(phaseId) {
    if (!state || state.finished[phaseId]) return;
    state.finished[phaseId] = true;
    state.doneUnits[phaseId] = state.totalUnits[phaseId];
    // Calibrate perUnit from measured wall time (EMA), persist.
    var startedAt = state.phaseStart[phaseId];
    if (startedAt) {
      var ms = now() - startedAt;
      var units = state.totalUnits[phaseId];
      if (units > 0 && ms > 0) {
        var observed = ms / units; // ms per unit
        var prev = state.perf[phaseId] || DEFAULT_PERUNIT[phaseId];
        state.perf[phaseId] = prev * (1 - EMA_ALPHA) + observed * EMA_ALPHA;
        savePerf(state.perf);
      }
    }
  }

  function updateThroughput(phaseId) {
    var last = state.lastReport[phaseId];
    var t = now();
    var doneUnits = state.doneUnits[phaseId];
    if (last) {
      var dt = t - last.t;
      var du = doneUnits - last.units;
      if (dt > 0 && du >= 0) {
        var rate = du / dt; // units per ms
        var prev = state.ema[phaseId];
        state.ema[phaseId] = (prev === undefined) ? rate : (prev * (1 - EMA_ALPHA) + rate * EMA_ALPHA);
      }
    }
    state.lastReport[phaseId] = { t: t, units: doneUnits };
  }

  function report(phaseId, doneUnits, extra) {
    if (!state || state.done) return;
    if (state.current !== phaseId) enter(phaseId, state.totalUnits[phaseId]);
    var total = state.totalUnits[phaseId];
    var clamped = Math.max(0, Math.min(doneUnits, total));
    state.doneUnits[phaseId] = clamped;
    updateThroughput(phaseId);

    // The only path to 100: render reaching its total.
    if (phaseId === 'render' && clamped >= total) {
      finish();
      return;
    }
    emit(extra);
  }

  function rescaleTail(actualHits) {
    if (!state || state.rescaled) return;
    state.rescaled = true;
    actualHits = Math.max(1, actualHits || 1);
    state.totalUnits.annot = actualHits;
    state.totalUnits.summ = actualHits;
    state.totalUnits.render = Math.min(actualHits, MAX_RENDER_ROWS);
    state.estUnits.annot = state.totalUnits.annot;
    state.estUnits.summ = state.totalUnits.summ;
    state.estUnits.render = state.totalUnits.render;
    emit();
  }

  function computePercent() {
    if (!state) return 0;
    var done = 0;
    for (var i = 0; i < PHASES.length; i++) {
      var ph = PHASES[i];
      if (state.finished[ph]) {
        done += phaseCost(ph, state.totalUnits[ph]);
      } else if (ph === state.current) {
        var frac = state.totalUnits[ph] > 0 ? (state.doneUnits[ph] / state.totalUnits[ph]) : 0;
        done += phaseCost(ph, state.totalUnits[ph]) * Math.max(0, Math.min(1, frac));
      }
    }
    var pct = (done / totalCost()) * 100;
    return pct;
  }

  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '';
    var totalSec = Math.round(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function throughputText() {
    if (!state || !state.current) return '';
    var ph = state.current;
    var rate = state.ema[ph]; // units per ms
    if (rate === undefined || rate <= 0) return '';
    var perSec = rate * 1000;
    if (ph === 'read' || ph === 'parse') {
      var mbps = perSec / (1024 * 1024);
      return mbps >= 0.01 ? mbps.toFixed(2) + ' MB/s' : Math.round(perSec) + ' B/s';
    }
    if (ph === 'scan') {
      // scannedUnits counts codon-checks across all six frame-passes (~6 per
      // base), so divide by 6 to report genuine sequence-traversal bp/s.
      var bpPerSec = perSec / 6;
      var mbpps = bpPerSec / 1e6;
      return mbpps >= 0.01 ? mbpps.toFixed(2) + ' Mbp/s' : Math.round(bpPerSec).toLocaleString() + ' bp/s';
    }
    // annot / summ / render: rows/s
    return Math.round(perSec).toLocaleString() + ' rows/s';
  }

  function etaText() {
    if (!state || !state.current) return '';
    var elapsed = now() - state.startTime;
    if (elapsed < WARMUP_MS) return 'estimating…';
    var ph = state.current;
    var rate = state.ema[ph];
    if (rate === undefined || rate <= 0) return 'estimating…';
    // Remaining cost across all phases / current cost-rate.
    var costRate = rate * (state.perf[ph] || DEFAULT_PERUNIT[ph]); // costUnits per ms
    if (costRate <= 0) return 'estimating…';
    var doneCost = (computePercent() / 100) * totalCost();
    var remainingCost = totalCost() - doneCost;
    if (remainingCost <= 0) return '';
    var etaMs = remainingCost / costRate;
    return '~' + formatDuration(etaMs) + ' remaining';
  }

  function emit(extra) {
    if (!state) return;
    var rawPct = computePercent();
    var pctInt = Math.floor(rawPct);
    if (!state.done) pctInt = Math.min(99, pctInt);
    if (pctInt < state.floorPercent) pctInt = state.floorPercent; // monotonic
    else state.floorPercent = pctInt;
    if (state.done) { pctInt = 100; state.floorPercent = 100; }

    var indeterminate = (!state.current) || (state.current === 'read' && !state.ema.read && state.floorPercent === 0);

    var payload = {
      percentInt: pctInt,
      phaseLabel: state.current ? (LABELS[state.current] || state.current) : 'Working…',
      elapsedMs: now() - state.startTime,
      throughputText: throughputText(),
      etaText: state.done ? '' : etaText(),
      indeterminate: !!indeterminate
    };
    if (extra && typeof extra === 'object') {
      for (var kk in extra) if (Object.prototype.hasOwnProperty.call(extra, kk)) payload[kk] = extra[kk];
    }
    for (var i = 0; i < updateCbs.length; i++) {
      try { updateCbs[i](payload); } catch (e) { /* a bad listener must not break the pipeline */ }
    }
  }

  function finish() {
    if (!state) return;
    if (state.current) completePhase(state.current);
    for (var i = 0; i < PHASES.length; i++) {
      if (!state.finished[PHASES[i]]) {
        state.finished[PHASES[i]] = true;
        state.doneUnits[PHASES[i]] = state.totalUnits[PHASES[i]];
      }
    }
    state.done = true;
    emit();
  }

  function cancel() { if (state) state.cancelled = true; }
  function isCancelled() { return !!(state && state.cancelled); }

  function onUpdate(cb) { if (typeof cb === 'function') updateCbs.push(cb); }

  var _yield = null;
  function yieldFn(cb) {
    if (!_yield) {
      _yield = (global.CodonScanner && global.CodonScanner.makeYield)
        ? global.CodonScanner.makeYield()
        : function (c) { global.setTimeout(c, 0); };
    }
    return _yield(cb);
  }

  global.ScanProgress = {
    PHASES: PHASES,
    LABELS: LABELS,
    begin: begin,
    enter: enter,
    report: report,
    rescaleTail: rescaleTail,
    finish: finish,
    cancel: cancel,
    isCancelled: isCancelled,
    onUpdate: onUpdate,
    yield: yieldFn
  };
})(typeof window !== 'undefined' ? window : this);
