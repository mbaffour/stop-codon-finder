/*
 * viz.js -- Self-contained inline-SVG visualizations for Stop Codon Finder.
 *
 * Exposes a global `CodonViz`. No libraries, no network, file:// safe. Every
 * chart is a single inline <svg> that (a) themes via the app's --codon-N /
 * --text / --accent CSS variables (so light/dark just works), (b) uses the
 * colorblind-safe codon palette by INDEX (never by codon name -- alt tables use
 * TCA/TTA/AGA/AGG), and (c) is directly serializable by CodonExport for SVG/PNG
 * download.
 *
 * Renderers (each clears `container`, draws, and returns the <svg> element):
 *   renderFrameTrack(container, opts)  six-frame stop-position track (sixpack)
 *   renderDensity(container, opts)     sliding-window stop-density plot
 *   renderCircular(container, opts)    circular genome plot (circular replicons)
 *
 * opts: { rec, hits, features, stops, onSelect, maxTicks }
 *   rec      {id, seq, circular}
 *   hits     ALL hits (filtered to rec.id internally)
 *   features annotation/ORF features (circular plot only)
 *   stops    active stop-codon list (for color-by-codon indexing + legend)
 *   onSelect fn(hitId) called when a stop tick is clicked (table linking)
 *   maxTicks per-view cap on individually drawn stop ticks (perf guard)
 *
 * LINKING: every stop tick carries data-hid="<hit id>". Hovering any element
 * with a given data-hid highlights ALL of them (across views + the results
 * table row), via the shared .viz-hl class. See CodonViz.highlight / wireLinking.
 */
(function (global, document) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FRAME_LANES = ['+1', '+2', '+3', '-1', '-2', '-3'];
  var DEFAULT_MAX_TICKS = 12000;

  function el(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function txt(x, y, s, attrs) {
    var t = el('text', attrs || {});
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.textContent = s;
    return t;
  }
  function codonColor(codon, stops) {
    var i = stops ? stops.indexOf(codon) : -1;
    return 'var(--codon-' + ((i >= 0 ? i : 5) % 6 + 1) + ')';
  }
  function hitsFor(hits, recId) {
    var out = [];
    for (var i = 0; i < (hits || []).length; i++) if (hits[i].seqId === recId) out.push(hits[i]);
    return out;
  }
  // "12,300 bp" style tick labels.
  function bpLabel(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 2 : 0) + ' Mb';
    if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + ' kb';
    return n + ' bp';
  }
  function niceStep(span, target) {
    var raw = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  // ---- Shared linking --------------------------------------------------

  var linkStyleInjected = false;
  function ensureLinkStyle() {
    if (linkStyleInjected) return;
    linkStyleInjected = true;
    // Highlight class lives in styles.css; nothing to inject at runtime, but we
    // keep the hook in case the stylesheet is absent (defensive, still works).
  }

  function highlight(id, on) {
    if (id == null) return;
    var nodes = document.querySelectorAll('[data-hid="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle('viz-hl', !!on);
  }

  // Event-delegated hover/click linking for a viz container's stop ticks.
  function wireLinking(container, onSelect) {
    container.addEventListener('mouseover', function (e) {
      var t = e.target.closest ? e.target.closest('[data-hid]') : null;
      if (t) highlight(t.getAttribute('data-hid'), true);
    });
    container.addEventListener('mouseout', function (e) {
      var t = e.target.closest ? e.target.closest('[data-hid]') : null;
      if (t) highlight(t.getAttribute('data-hid'), false);
    });
    container.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-hid]') : null;
      if (t && typeof onSelect === 'function') onSelect(t.getAttribute('data-hid'));
    });
  }

  function finish(container, svg, opts) {
    ensureLinkStyle();
    container.innerHTML = '';
    container.appendChild(svg);
    wireLinking(container, opts && opts.onSelect);
    return svg;
  }

  function emptyNote(container, message) {
    container.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'viz-empty';
    p.textContent = message;
    container.appendChild(p);
    return null;
  }

  // ---- 1) Six-frame stop-position track --------------------------------

  function renderFrameTrack(container, opts) {
    opts = opts || {};
    var rec = opts.rec, stops = opts.stops || [];
    if (!rec || !rec.seq) return emptyNote(container, 'No sequence to plot.');
    var L = rec.seq.length;
    var recHits = hitsFor(opts.hits, rec.id);
    var maxTicks = opts.maxTicks || DEFAULT_MAX_TICKS;
    if (recHits.length > maxTicks) {
      return emptyNote(container, 'Six-frame track skipped: ' + recHits.length.toLocaleString() +
        ' stops in this sequence exceed the ' + maxTicks.toLocaleString() +
        '-tick display cap. See the density plot below for the genome-wide view.');
    }

    var W = 900, laneH = 22, laneGap = 6, top = 30, left = 54, right = 20, axisH = 26;
    var plotW = W - left - right;
    var H = top + FRAME_LANES.length * (laneH + laneGap) + axisH;
    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H,
      role: 'img', 'aria-label': 'Six-frame stop-codon position track'
    });
    svg.appendChild(txt(left, 18, 'Six-frame stop map — ' + rec.id + ' (' + bpLabel(L) + ')',
      { 'font-size': 13, 'font-weight': 600, fill: 'var(--text)' }));

    function x(pos) { return left + (L > 1 ? (pos - 1) / (L - 1) : 0) * plotW; }

    // Lane backgrounds + labels.
    var laneY = {};
    FRAME_LANES.forEach(function (lane, i) {
      var y = top + i * (laneH + laneGap);
      laneY[lane] = y;
      svg.appendChild(el('rect', { x: left, y: y, width: plotW, height: laneH,
        fill: 'var(--bg-subtle)', rx: 3 }));
      svg.appendChild(txt(left - 8, y + laneH / 2 + 4, lane,
        { 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600,
          fill: i < 3 ? 'var(--text)' : 'var(--text-muted)' }));
    });

    // Stop ticks.
    recHits.forEach(function (h) {
      var lane = (h.strand === '-' ? '-' : '+') + h.frame;
      if (laneY[lane] === undefined) return;
      var px = x(h.start);
      var line = el('line', {
        x1: px.toFixed(1), y1: laneY[lane], x2: px.toFixed(1), y2: laneY[lane] + laneH,
        stroke: codonColor(h.codon, stops), 'stroke-width': 1.4, class: 'viz-tick'
      });
      if (h.id != null) line.setAttribute('data-hid', h.id);
      var title = el('title');
      title.textContent = h.codon + ' ' + lane + ' @ ' + h.start + '-' + h.end +
        (h.geneName ? ' (' + h.geneName + ')' : '');
      line.appendChild(title);
      svg.appendChild(line);
    });

    // Position axis.
    var axisY = top + FRAME_LANES.length * (laneH + laneGap) + 4;
    svg.appendChild(el('line', { x1: left, y1: axisY, x2: left + plotW, y2: axisY,
      stroke: 'var(--border-strong)', 'stroke-width': 1 }));
    var step = niceStep(L, 8);
    for (var p = 0; p <= L; p += step) {
      var pos = Math.max(1, p);
      var px = x(pos);
      svg.appendChild(el('line', { x1: px, y1: axisY, x2: px, y2: axisY + 4, stroke: 'var(--border-strong)' }));
      svg.appendChild(txt(px, axisY + 16, bpLabel(p),
        { 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-muted)' }));
    }

    return finish(container, svg, opts);
  }

  // ---- 2) Sliding-window stop-density plot -----------------------------

  function renderDensity(container, opts) {
    opts = opts || {};
    var rec = opts.rec;
    if (!rec || !rec.seq) return emptyNote(container, 'No sequence to plot.');
    var L = rec.seq.length;
    var recHits = hitsFor(opts.hits, rec.id);

    var W = 900, top = 30, left = 54, right = 20, bottom = 34, plotH = 150;
    var plotW = W - left - right;
    var H = top + plotH + bottom;

    // Bin count scales with width; window size derived from bins.
    var bins = Math.max(1, Math.min(600, Math.round(plotW / 3)));
    var binSize = Math.max(1, Math.ceil(L / bins));
    var nBins = Math.ceil(L / binSize);
    var plus = new Array(nBins), minus = new Array(nBins);
    for (var b = 0; b < nBins; b++) { plus[b] = 0; minus[b] = 0; }
    recHits.forEach(function (h) {
      var idx = Math.min(nBins - 1, Math.floor((h.start - 1) / binSize));
      if (h.strand === '-') minus[idx]++; else plus[idx]++;
    });
    var maxV = 1;
    for (var i = 0; i < nBins; i++) { var tot = plus[i] + minus[i]; if (tot > maxV) maxV = tot; }

    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H,
      role: 'img', 'aria-label': 'Stop-codon density along the sequence'
    });
    svg.appendChild(txt(left, 18, 'Stop-codon density — window ' + bpLabel(binSize) +
      ' (peak ' + maxV + ' per window)', { 'font-size': 13, 'font-weight': 600, fill: 'var(--text)' }));

    // Plot each bin at the GENOMIC CENTRE of the bases it covers, using the SAME
    // base->x mapping as the position axis below (px = left + (pos/L)*plotW). Bin
    // b covers bases [b*binSize, (b+1)*binSize), centre (b+0.5)*binSize; clamped
    // to plotW so the final partial bin can't spill past the right margin. This
    // keeps the density curve, its own base axis, and the six-frame track in
    // register (previously bins were stretched over 0..nBins-1, a nBins/(nBins-1)
    // scale mismatch vs the axis).
    function x(binIdx) { return left + (L > 0 ? Math.min(1, (binIdx + 0.5) * binSize / L) : 0) * plotW; }
    function y(v) { return top + plotH - (v / maxV) * plotH; }

    // Baseline + a couple of gridlines.
    svg.appendChild(el('line', { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH,
      stroke: 'var(--border-strong)' }));

    // Stacked area: plus (accent) then plus+minus (codon-5) so both strands show.
    function areaPath(vals) {
      var d = 'M ' + left + ' ' + (top + plotH);
      for (var k = 0; k < nBins; k++) d += ' L ' + x(k).toFixed(1) + ' ' + y(vals[k]).toFixed(1);
      d += ' L ' + (left + plotW) + ' ' + (top + plotH) + ' Z';
      return d;
    }
    var combined = plus.map(function (v, k) { return v + minus[k]; });
    svg.appendChild(el('path', { d: areaPath(combined), fill: 'var(--codon-5)', 'fill-opacity': 0.35, stroke: 'none' }));
    svg.appendChild(el('path', { d: areaPath(plus), fill: 'var(--accent)', 'fill-opacity': 0.5, stroke: 'none' }));
    // Total outline.
    var line = 'M';
    for (var m = 0; m < nBins; m++) line += ' ' + x(m).toFixed(1) + ' ' + y(combined[m]).toFixed(1);
    svg.appendChild(el('path', { d: line, fill: 'none', stroke: 'var(--accent-strong)', 'stroke-width': 1.2 }));

    // Y axis labels (0 / max).
    svg.appendChild(txt(left - 8, top + 4, String(maxV), { 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-muted)' }));
    svg.appendChild(txt(left - 8, top + plotH, '0', { 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-muted)' }));

    // Position axis.
    var step = niceStep(L, 8);
    for (var p = 0; p <= L; p += step) {
      var px = left + (L > 1 ? p / L : 0) * plotW;
      svg.appendChild(el('line', { x1: px, y1: top + plotH, x2: px, y2: top + plotH + 4, stroke: 'var(--border-strong)' }));
      svg.appendChild(txt(px, top + plotH + 16, bpLabel(p), { 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-muted)' }));
    }

    // Legend.
    svg.appendChild(el('rect', { x: left, y: H - 12, width: 10, height: 10, fill: 'var(--accent)', 'fill-opacity': 0.5 }));
    svg.appendChild(txt(left + 14, H - 3, 'forward (+)', { 'font-size': 10, fill: 'var(--text-muted)' }));
    svg.appendChild(el('rect', { x: left + 90, y: H - 12, width: 10, height: 10, fill: 'var(--codon-5)', 'fill-opacity': 0.35 }));
    svg.appendChild(txt(left + 104, H - 3, 'reverse (−)', { 'font-size': 10, fill: 'var(--text-muted)' }));

    return finish(container, svg, opts);
  }

  // ---- 3) Circular genome plot -----------------------------------------

  function polar(cx, cy, r, angleDeg) {
    var a = (angleDeg - 90) * Math.PI / 180; // 0deg = 12 o'clock, clockwise
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  // Arc path from a0 to a1 (degrees, clockwise) at radius r.
  function arcPath(cx, cy, r, a0, a1) {
    var p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    var large = ((a1 - a0) % 360 + 360) % 360 > 180 ? 1 : 0;
    return 'M ' + p0.x.toFixed(2) + ' ' + p0.y.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2);
  }

  function renderCircular(container, opts) {
    opts = opts || {};
    var rec = opts.rec, stops = opts.stops || [];
    if (!rec || !rec.seq) return emptyNote(container, 'No sequence to plot.');
    var L = rec.seq.length;
    var recHits = hitsFor(opts.hits, rec.id);
    var maxTicks = opts.maxTicks || DEFAULT_MAX_TICKS;
    if (recHits.length > maxTicks) {
      return emptyNote(container, 'Circular plot skipped: ' + recHits.length.toLocaleString() +
        ' stops exceed the display cap.');
    }

    var size = 520, cx = size / 2, cy = size / 2;
    var Rseq = size / 2 - 40;         // backbone ring
    var Rgene = Rseq - 14;            // gene band radius
    var geneW = 9;
    var svg = el('svg', {
      viewBox: '0 0 ' + size + ' ' + size, width: size, height: size,
      role: 'img', 'aria-label': 'Circular genome plot of stops and genes for ' + rec.id
    });
    function ang(pos) { return (L > 0 ? (pos - 1) / L : 0) * 360; }

    // Backbone circle.
    svg.appendChild(el('circle', { cx: cx, cy: cy, r: Rseq, fill: 'none',
      stroke: 'var(--border-strong)', 'stroke-width': 1.5 }));

    // Genes as arcs on inner bands (+ outside, - inside), colored by strand.
    var feats = (opts.features || []).filter(function (f) {
      return f.seqId === rec.id && (f.type === 'CDS' || f.type === 'ORF' || f.type === 'gene');
    });
    feats.forEach(function (f) {
      var a0 = ang(f.start), a1 = ang(f.end);
      if (a1 <= a0) a1 = a0 + Math.max(0.4, ang(f.end + L) - a0); // guard tiny/degenerate
      var r = f.strand === '-' ? Rgene - geneW : Rgene;
      svg.appendChild(el('path', {
        d: arcPath(cx, cy, r, a0, a1), fill: 'none',
        stroke: f.strand === '-' ? 'var(--codon-4)' : 'var(--accent)',
        'stroke-width': geneW, 'stroke-linecap': 'butt', 'stroke-opacity': 0.75
      }));
    });

    // Stop ticks radiating just outside the backbone, colored by codon.
    recHits.forEach(function (h) {
      var a = ang(h.start);
      var inner = h.strand === '-' ? Rseq - 4 : Rseq;
      var outer = h.strand === '-' ? Rseq : Rseq + 8;
      var p0 = polar(cx, cy, inner, a), p1 = polar(cx, cy, outer, a);
      var line = el('line', {
        x1: p0.x.toFixed(2), y1: p0.y.toFixed(2), x2: p1.x.toFixed(2), y2: p1.y.toFixed(2),
        stroke: codonColor(h.codon, stops), 'stroke-width': 1.3, class: 'viz-tick'
      });
      if (h.id != null) line.setAttribute('data-hid', h.id);
      var title = el('title');
      title.textContent = h.codon + ' ' + (h.strand === '-' ? '-' : '+') + h.frame + ' @ ' + h.start +
        (h.geneName ? ' (' + h.geneName + ')' : '');
      line.appendChild(title);
      svg.appendChild(line);
    });

    // Origin marker + position ticks around the ring.
    var step = niceStep(L, 8);
    for (var p = 0; p < L; p += step) {
      var a = ang(Math.max(1, p));
      var t0 = polar(cx, cy, Rseq, a), t1 = polar(cx, cy, Rseq + 12, a);
      svg.appendChild(el('line', { x1: t0.x.toFixed(2), y1: t0.y.toFixed(2), x2: t1.x.toFixed(2), y2: t1.y.toFixed(2),
        stroke: 'var(--border-strong)' }));
      var lab = polar(cx, cy, Rseq + 24, a);
      svg.appendChild(txt(lab.x.toFixed(1), lab.y.toFixed(1), bpLabel(p),
        { 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--text-muted)' }));
    }

    // Center label.
    svg.appendChild(txt(cx, cy - 6, rec.id, { 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 600, fill: 'var(--text)' }));
    svg.appendChild(txt(cx, cy + 12, bpLabel(L) + ' · circular', { 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }));

    return finish(container, svg, opts);
  }

  // ---- 4) Gene / ORF map -----------------------------------------------
  //
  // A linear genome track: every CDS / predicted-ORF drawn as a directional
  // arrow in ITS reading-frame lane (six lanes: +1/+2/+3 forward, -1/-2/-3
  // reverse). The body is a neutral theme colour; the terminating stop codon is
  // the arrowhead at the 3' end, COLOURED BY CODON TYPE via the active palette
  // (var(--codon-N), same indexing as every other chart + the legend/table).
  // The arrow points in the direction of transcription (+ right, - left).

  var DEFAULT_MAX_GENES = 8000; // hard render cap (E. coli ~4,318 CDS renders in full)
  var FOCUS_CAP = 600;          // add per-gene keyboard focus only below this count

  // The stable key by which a hit's featureId identifies its feature. Mirrors
  // annotate.applyName: id || locusTag || name.
  function featureKey(f) { return f.id != null ? f.id : (f.locusTag != null ? f.locusTag : f.name); }

  // A gene's frame lane, derived from its terminating stop hit when known
  // (exact), else computed from the 3'-terminal codon geometry (fallback for
  // partial / terminator-less features). Returns '+1'..'-3'.
  function geneLane(f, term, L) {
    if (term && term.frame) return (term.strand === '-' ? '-' : '+') + term.frame;
    var frame;
    if (f.strand === '-') {
      // Reverse: terminating codon occupies forward [start, start+2]; its 0-based
      // reading position in the reverse-complement strand is L-(start+2).
      frame = (((L - (f.start + 2)) % 3) + 3) % 3 + 1;
    } else {
      // Forward: terminating codon starts at end-2 (1-based) -> frame of that base.
      frame = ((((f.end - 2) - 1) % 3) + 3) % 3 + 1;
    }
    return (f.strand === '-' ? '-' : '+') + frame;
  }

  function geneName(f) {
    return f.name || f.locusTag || f.id || (f.type === 'ORF' ? 'ORF' : 'CDS');
  }

  function renderGeneMap(container, opts) {
    opts = opts || {};
    var rec = opts.rec, stops = opts.stops || [];
    if (!rec || !rec.seq) return emptyNote(container, 'No sequence to plot.');
    var L = rec.seq.length;

    var allFeats = (opts.features || []).filter(function (f) {
      return f && f.seqId === rec.id && (f.type === 'CDS' || f.type === 'ORF');
    });
    if (!allFeats.length) return emptyNote(container, 'No genes or predicted ORFs to map for this sequence.');

    // Map featureKey -> its terminating stop hit (for lane, cap colour, linking).
    var recHits = hitsFor(opts.hits, rec.id);
    var termByKey = {};
    recHits.forEach(function (h) {
      if (h.context !== 'cds-terminator' && h.context !== 'orf-terminator') return;
      if (h.featureId != null && termByKey[h.featureId] === undefined) termByKey[h.featureId] = h;
      if (h.terminatorFeatureIds) {
        for (var i = 0; i < h.terminatorFeatureIds.length; i++) {
          var id = h.terminatorFeatureIds[i];
          if (termByKey[id] === undefined) termByKey[id] = h;
        }
      }
    });

    // Perf cap: draw at most MAX features (by genomic start); never silently drop.
    var MAX = opts.maxGenes || DEFAULT_MAX_GENES;
    var total = allFeats.length;
    var feats = allFeats;
    var capped = false;
    if (total > MAX) {
      feats = allFeats.slice().sort(function (a, b) { return a.start - b.start; }).slice(0, MAX);
      capped = true;
    }
    var anyCDS = allFeats.some(function (f) { return f.type === 'CDS'; });
    var kindWord = anyCDS ? 'gene / CDS' : 'predicted ORF';
    var focusable = feats.length <= FOCUS_CAP;

    var W = 900, laneH = 24, laneGap = 7, top = 42, left = 54, right = 20;
    var axisH = 26, legendH = 26;
    var plotW = W - left - right;
    var H = top + FRAME_LANES.length * (laneH + laneGap) + axisH + legendH;
    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H,
      role: 'img',
      'aria-label': 'Gene and ORF map: ' + total + ' ' + kindWord + ' feature' + (total === 1 ? '' : 's') +
        ' along ' + rec.id + ' (' + bpLabel(L) + '), each drawn as a directional arrow in its reading-frame lane ' +
        '(forward +1/+2/+3, reverse -1/-2/-3) with its terminating stop codon coloured by type.'
    });
    svg.appendChild(txt(left, 18, 'Gene / ORF map — ' + rec.id + ' (' + bpLabel(L) + ')',
      { 'font-size': 13, 'font-weight': 600, fill: 'var(--text)' }));
    svg.appendChild(txt(left, 33, (capped ? ('showing ' + feats.length.toLocaleString() + ' of ' +
      total.toLocaleString() + ' — narrow the region or raise the minimum ORF length')
      : (total.toLocaleString() + ' ' + kindWord + ' feature' + (total === 1 ? '' : 's') +
        ' · arrow points 5′→3′; stop coloured by codon')),
      { 'font-size': 10.5, fill: capped ? 'var(--codon-4)' : 'var(--text-muted)' }));

    function x(pos) { return left + (L > 1 ? (pos - 1) / (L - 1) : 0) * plotW; }

    // Lane backgrounds + labels.
    var laneY = {};
    FRAME_LANES.forEach(function (lane, i) {
      var y = top + i * (laneH + laneGap);
      laneY[lane] = y;
      svg.appendChild(el('rect', { x: left, y: y, width: plotW, height: laneH,
        fill: 'var(--bg-subtle)', rx: 3 }));
      svg.appendChild(txt(left - 8, y + laneH / 2 + 4, lane,
        { 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600,
          fill: i < 3 ? 'var(--text)' : 'var(--text-muted)' }));
    });

    // Draw each gene/ORF as a directional arrow in its frame lane.
    var barH = 11, cap = 4, AH = 6; // body height, half-cap height beyond body, arrow length
    var tipData = [];
    feats.forEach(function (f, gi) {
      var lane = geneLane(f, termByKey[featureKey(f)], L);
      var y = laneY[lane];
      if (y === undefined) return;
      var yc = y + laneH / 2;
      var by = yc - barH / 2;
      var term = termByKey[featureKey(f)];
      var minus = f.strand === '-';
      // Geometry from the biological 5'->3' exons, NOT f.start/f.end: for an
      // origin-wrapping circular feature (e.g. phiX174 gene A join(3981..5386,1..136))
      // genbank.js collapses f.start/f.end to the whole-genome span, which would draw the
      // gene across the entire axis with its stop at the wrong end. orderedSegments carries
      // the true 5'->3' order (reversed from file order for '-'); the 3' terminus is the
      // stop location.
      var oseg = (f.orderedSegments && f.orderedSegments.length) ? f.orderedSegments
        : (function () {
            var s = (f.segments && f.segments.length) ? f.segments.slice() : [{ start: f.start, end: f.end }];
            if (minus) s.reverse();
            return s;
          })();
      var threeSeg = oseg[oseg.length - 1];
      var threePos = minus ? threeSeg.start : threeSeg.end; // true 3' terminus = stop location

      var g = el('g', { class: 'gene-glyph' });
      if (term && term.id != null) g.setAttribute('data-hid', term.id);
      g.setAttribute('data-gi', gi);

      // Intron connectors between consecutive exons (behind the exon rects). Skip any
      // jump spanning most of the axis (an origin crossing on a circular feature), so a
      // wrapping gene never reads as one full-width bar -- its exon rects still show both
      // pieces at their true positions.
      for (var si = 0; si < oseg.length - 1; si++) {
        var cA = minus ? x(oseg[si].start) : x(oseg[si].end);
        var cB = minus ? x(oseg[si + 1].end) : x(oseg[si + 1].start);
        if (Math.abs(cB - cA) > plotW * 0.5) continue; // origin-crossing jump
        g.appendChild(el('line', { x1: cA.toFixed(1), y1: yc, x2: cB.toFixed(1), y2: yc,
          stroke: 'var(--border-strong)', 'stroke-width': 1 }));
      }

      // Exon bodies (one rect per segment; single-segment genes -> one rect).
      var segs = (f.segments && f.segments.length) ? f.segments : [{ start: f.start, end: f.end }];
      segs.forEach(function (sg) {
        var sx0 = x(sg.start), sx1 = x(sg.end);
        if (sx1 - sx0 < 1.5) sx1 = sx0 + 1.5;
        g.appendChild(el('rect', { x: sx0.toFixed(1), y: by.toFixed(1),
          width: (sx1 - sx0).toFixed(1), height: barH, rx: 1.5,
          fill: 'var(--border-strong)', 'fill-opacity': 0.85 }));
      });

      // Terminating stop = coloured arrowhead at the 3' end.
      var col = term ? codonColor(term.codon, stops) : 'var(--text-muted)';
      var tipX, baseX;
      baseX = x(threePos); // anchor at the true 3' terminus (last ordered exon)
      tipX = minus ? baseX - AH : baseX + AH;
      var head = el('path', {
        d: 'M ' + baseX.toFixed(1) + ' ' + (yc - barH / 2 - cap).toFixed(1) +
           ' L ' + tipX.toFixed(1) + ' ' + yc.toFixed(1) +
           ' L ' + baseX.toFixed(1) + ' ' + (yc + barH / 2 + cap).toFixed(1) + ' Z',
        fill: col, stroke: 'var(--bg-elevated)', 'stroke-width': 0.5
      });
      g.appendChild(head);

      var nm = geneName(f);
      var coords = (oseg.length > 1)
        ? oseg.map(function (s) { return s.start.toLocaleString() + '–' + s.end.toLocaleString(); }).join(', ') + ' bp'
        : f.start.toLocaleString() + '–' + f.end.toLocaleString() + ' bp';
      var tipText = nm + ' · ' + f.type + ' · strand ' + (minus ? '−' : '+') + ' · frame ' + lane +
        ' · ' + coords + ' · stop ' + (term ? term.codon : 'none detected');
      var title = el('title'); title.textContent = tipText; g.appendChild(title);
      tipData[gi] = tipText;

      if (focusable) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'img');
        g.setAttribute('aria-label', tipText);
      }
      svg.appendChild(g);
    });

    // Position axis (same base->x mapping as the six-frame track, so they align).
    var axisY = top + FRAME_LANES.length * (laneH + laneGap) + 4;
    svg.appendChild(el('line', { x1: left, y1: axisY, x2: left + plotW, y2: axisY,
      stroke: 'var(--border-strong)', 'stroke-width': 1 }));
    var step = niceStep(L, 8);
    for (var p = 0; p <= L; p += step) {
      var pos = Math.max(1, p);
      var px = x(pos);
      svg.appendChild(el('line', { x1: px, y1: axisY, x2: px, y2: axisY + 4, stroke: 'var(--border-strong)' }));
      svg.appendChild(txt(px, axisY + 16, bpLabel(p),
        { 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--text-muted)' }));
    }

    // Legend: codon colours (active stop set) + strand/arrow note.
    var lgY = axisY + axisH;
    var lx = left;
    stops.forEach(function (codon) {
      svg.appendChild(el('path', {
        d: 'M ' + lx + ' ' + (lgY - 5) + ' L ' + (lx + 9) + ' ' + lgY + ' L ' + lx + ' ' + (lgY + 5) + ' Z',
        fill: codonColor(codon, stops)
      }));
      var t = txt(lx + 13, lgY + 4, codon, { 'font-size': 10, fill: 'var(--text-muted)' });
      svg.appendChild(t);
      lx += 13 + codon.length * 7 + 12;
    });
    svg.appendChild(txt(lx + 4, lgY + 4, '▸ arrow = 3′ stop; points 5′→3′ (+ right, − left)',
      { 'font-size': 10, fill: 'var(--text-muted)' }));

    finish(container, svg, opts);

    // Rich hover / focus tooltip (in addition to the native <title>). The tooltip
    // node is a sibling of the SVG so figure export (which clones the SVG) is
    // unaffected. Positioned with position:fixed against the pointer/element.
    var tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    container.appendChild(tip);
    function showTipFor(g, cx, cy) {
      var gi = g.getAttribute('data-gi');
      if (gi == null || tipData[gi] == null) return;
      tip.textContent = tipData[gi];
      tip.hidden = false;
      var pad = 12;
      tip.style.left = Math.min(cx + pad, global.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.max(8, cy - tip.offsetHeight - pad) + 'px';
    }
    function hideTip() { tip.hidden = true; }
    svg.addEventListener('mousemove', function (e) {
      var g = e.target.closest ? e.target.closest('.gene-glyph') : null;
      if (g) showTipFor(g, e.clientX, e.clientY); else hideTip();
    });
    svg.addEventListener('mouseleave', hideTip);
    svg.addEventListener('focusin', function (e) {
      var g = e.target.closest ? e.target.closest('.gene-glyph') : null;
      if (!g) return;
      var r = g.getBoundingClientRect();
      showTipFor(g, r.left + r.width / 2, r.top + r.height / 2 + tip.offsetHeight + 24);
    });
    svg.addEventListener('focusout', hideTip);

    return svg;
  }

  global.CodonViz = {
    FRAME_LANES: FRAME_LANES,
    highlight: highlight,
    wireLinking: wireLinking,
    renderFrameTrack: renderFrameTrack,
    renderDensity: renderDensity,
    renderCircular: renderCircular,
    renderGeneMap: renderGeneMap
  };
})(typeof window !== 'undefined' ? window : this, document);
