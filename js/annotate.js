/*
 * annotate.js -- Gene mapping / context classification for stop-codon hits.
 *
 * Exposes a global `CodonAnnotate`:
 *   CodonAnnotate.buildIndex(features) -> index
 *   CodonAnnotate.assignTerminators(hits, features, ctx) -> Map<hit,feature>
 *   CodonAnnotate.annotate(hits, features, options) -> Promise<void>  // mutates hits
 *   CodonAnnotate.classifyHit(hit, index, strict, ctx, termMap) -> {context,...}
 *
 * cds-terminator / orf-terminator are assigned by assignTerminators (a
 * CDS/ORF-driven pass where each feature claims exactly ONE 3'-terminal stop),
 * NOT by a per-hit ±3 tolerance test; classifyHit reads that map. This keeps the
 * terminator count equal to the number of distinct true CDS terminators.
 *
 * The index is an augmented interval index: per (seqId,strand) an array of
 * segments sorted by start, plus a prefix-max of segment ends (maxEndPrefix)
 * so overlap queries run in O(log n + k). This is mandatory for large,
 * overlapping annotations (e.g. E. coli).
 *
 * Context enum (build brief 5.2):
 *   cds-terminator, cds-internal-inframe, cds-internal-outframe,
 *   within-noncoding-gene, intergenic, orf-terminator
 */
(function (global) {
  'use strict';

  var NONCODING_GENE_TYPES = { gene: 1, mRNA: 1, tRNA: 1, rRNA: 1, transcript: 1, ncRNA: 1, tmRNA: 1 };

  function keyOf(seqId, strand) { return seqId + '\u0000' + strand; }

  function buildIndex(features) {
    var groups = {}; // key -> {segs:[{start,end,feat}], maxEndPrefix:[], wide:[]}
    features = features || [];
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (!f || !f.segments || !f.segments.length) continue;
      var k = keyOf(f.seqId, f.strand);
      if (!groups[k]) groups[k] = { segs: [], maxEndPrefix: [], wide: [] };
      for (var s = 0; s < f.segments.length; s++) {
        groups[k].segs.push({ start: f.segments[s].start, end: f.segments[s].end, feat: f });
      }
    }
    for (var key in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
      var g = groups[key];
      g.segs.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

      // Segregate abnormally wide segments (e.g. a eukaryotic gene/mRNA row
      // spanning tens of kb to Mb) into a small linear-scan bucket. The
      // augmented-interval prefix-max prunes only on the left, so a single wide
      // early segment keeps pref[i] high all the way to index 0 and degrades the
      // query to O(n). Pulling those few outliers out keeps the main index's
      // spans bounded so the prune terminates quickly; the bucket stays tiny.
      var spans = [];
      for (var m = 0; m < g.segs.length; m++) spans.push(g.segs[m].end - g.segs[m].start);
      var cutoff = wideCutoff(spans);
      var narrow = [];
      for (var n = 0; n < g.segs.length; n++) {
        if ((g.segs[n].end - g.segs[n].start) > cutoff) g.wide.push(g.segs[n]);
        else narrow.push(g.segs[n]);
      }
      g.segs = narrow;

      var pref = new Array(g.segs.length);
      var running = -Infinity;
      for (var j = 0; j < g.segs.length; j++) {
        if (g.segs[j].end > running) running = g.segs[j].end;
        pref[j] = running;
      }
      g.maxEndPrefix = pref;
    }
    return { groups: groups };
  }

  // Cutoff span above which a segment is treated as a wide outlier. Adaptive:
  // well above the median span, with an absolute floor so ordinary genes never
  // get bucketed. Correctness is independent of the cutoff (the bucket is always
  // scanned in full); it only affects performance.
  function wideCutoff(spans) {
    if (!spans.length) return Infinity;
    var sorted = spans.slice().sort(function (a, b) { return a - b; });
    var median = sorted[sorted.length >> 1];
    var adaptive = median * 16;
    var floor = 16384;
    return Math.max(adaptive, floor);
  }

  // Largest index i with segs[i].start <= value; -1 if none.
  function upperBoundStart(segs, value) {
    var lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].start <= value) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  // Collect segments overlapping [qs,qe] on a given (seqId,strand) group.
  function querySegments(group, qs, qe) {
    var out = [];
    if (!group) return out;
    var segs = group.segs;
    var pref = group.maxEndPrefix;
    if (segs && segs.length) {
      var i = upperBoundStart(segs, qe);
      while (i >= 0 && pref[i] >= qs) {
        var seg = segs[i];
        if (seg.end >= qs && seg.start <= qe) out.push(seg);
        i--;
      }
    }
    // Wide outliers (kept out of the augmented index) are scanned linearly.
    var wide = group.wide;
    if (wide && wide.length) {
      for (var w = 0; w < wide.length; w++) {
        if (wide[w].end >= qs && wide[w].start <= qe) out.push(wide[w]);
      }
    }
    return out;
  }

  // Biological 5'->3' ordering + true termini for a feature, cached on it.
  // Uses feat.orderedSegments when the parser supplied it (this is what carries
  // ORIGIN-wrapping order for circular join() features); otherwise falls back to
  // deriving order from the ascending segments by strand. `three` is the forward
  // coordinate of the biological 3'-terminal base (where the stop codon ends),
  // NOT max/min(coord), so wrapped genes classify correctly.
  function getOrdered(feat) {
    if (feat._ord) return feat._ord;
    var ordered = feat.orderedSegments;
    if (!ordered || !ordered.length) {
      ordered = feat.segments.slice();
      if (feat.strand === '-') ordered.reverse();
    }
    var last = ordered[ordered.length - 1];
    var first = ordered[0];
    var three, five;
    if (feat.strand === '+') { three = last.end; five = first.start; }
    else { three = last.start; five = first.end; }
    var wraps = (feat.strand === '+') ? (five > three) : (five < three);
    feat._ord = { ordered: ordered, three: three, five: five, wraps: wraps };
    return feat._ord;
  }

  // Compute the coding offset (0-based) of forward position within a CDS/ORF
  // feature, accounting for splicing, in the feature's own 5'->3' direction.
  // Returns null if the position is not inside any segment.
  function codingOffset(feat, hs, he) {
    var ordered = getOrdered(feat).ordered;
    var acc = 0;
    if (feat.strand === '+') {
      // Walk segments in biological 5'->3' order. Offset measured from hs.
      for (var i = 0; i < ordered.length; i++) {
        var sg = ordered[i];
        if (hs >= sg.start && hs <= sg.end) return acc + (hs - sg.start);
        acc += (sg.end - sg.start + 1);
      }
      return null;
    }
    // '-' : biological 5'->3' order already (highest coord first). Measure from he.
    for (var j = 0; j < ordered.length; j++) {
      var sg2 = ordered[j];
      if (he >= sg2.start && he <= sg2.end) return acc + (sg2.end - he);
      acc += (sg2.end - sg2.start + 1);
    }
    return null;
  }

  // §5.3 terminator test for one CDS/ORF feature. Returns the coordinate
  // distance of the match (0 = exact) or -1 when the hit is not this feature's
  // terminating stop. The distance lets classifyHit pick the *closest* CDS when
  // several overlapping/abutting genes are within tolerance (fixes the phiX174
  // p07/p08 cross-attribution). The stop-INCLUDED branch additionally requires
  // the hit to sit in the feature's reading frame, which rejects out-of-frame
  // internal stops that merely happen to lie within ±tol of the 3' terminus.
  function terminatorDist(feat, hs, he, strict) {
    var three = getOrdered(feat).three;
    var tol = strict ? 0 : 3;
    var best = -1;
    if (feat.strand === '+') {
      // stop included: he===three (in-frame) ; stop excluded: hs===three+1
      var dIncl = Math.abs(he - three);
      if (dIncl <= tol && inReadingFrame(feat, hs, he)) best = dIncl;
      var dExcl = Math.abs(hs - (three + 1));
      if (dExcl <= tol && (best < 0 || dExcl < best)) best = dExcl;
    } else {
      // '-' : stop included: hs===three (in-frame) ; stop excluded: he===three-1
      var dIncl2 = Math.abs(hs - three);
      if (dIncl2 <= tol && inReadingFrame(feat, hs, he)) best = dIncl2;
      var dExcl2 = Math.abs(he - (three - 1));
      if (dExcl2 <= tol && (best < 0 || dExcl2 < best)) best = dExcl2;
    }
    return best;
  }

  // Phase (0/1/2) of the feature's 5'-most segment: bases to skip at the 5' end
  // before the first codon. Set from GFF3 column 8 / GenBank /codon_start. A
  // 5'-partial CDS with phase 1 or 2 has its internal reading frame shifted, so
  // the in-frame test must subtract the phase.
  function framePhase(feat) {
    var p = feat.phase;
    return (p === 1 || p === 2) ? p : 0;
  }

  // True when the hit's coding-frame offset (adjusted for the feature's phase)
  // is a multiple of 3 (i.e. it is an in-frame codon of the feature). Only
  // meaningful for stop-included matches, where the hit lies inside the CDS.
  function inReadingFrame(feat, hs, he) {
    var off = codingOffset(feat, hs, he);
    if (off === null) return false;
    return (((off - framePhase(feat)) % 3) + 3) % 3 === 0;
  }

  // ---- Per-feature genetic code + recoding awareness -------------------

  // The definite stop set for a feature's own genetic code: its /transl_table
  // (GenBank/GFF) when present, else the global run table. Cached on ctx.
  function featureStops(feat, ctx) {
    if (!ctx || !global.CodonTables) return null;
    var tid = (feat && feat.translTable != null) ? feat.translTable : ctx.tableId;
    if (tid == null) return null;
    var cache = ctx._stopCache || (ctx._stopCache = {});
    if (!cache[tid]) cache[tid] = global.CodonTables.stopSet(tid);
    return cache[tid];
  }

  // Is `codon` a stop under THIS feature's genetic code? Resolves ambiguity the
  // same way the scanner does. Returns true when no table info is available (so
  // behavior is unchanged for annotations without a declared code).
  function isStopInFeature(feat, codon, ctx) {
    var s = featureStops(feat, ctx);
    if (!s) return true;
    if (s[codon]) return true;
    if (global.CodonScanner && global.CodonScanner.resolveAmbiguousStop) {
      return !!global.CodonScanner.resolveAmbiguousStop(codon, s);
    }
    return false;
  }

  // If the hit position falls on a GenBank /transl_except record of this
  // feature, return its amino acid (e.g. 'Sec', 'Pyl') — a genuine recoding
  // that must NOT be reported as a premature stop. Returns null otherwise.
  function knownRecoding(feat, hs, he) {
    var te = feat.translExcept;
    if (!te || !te.length) return null;
    for (var i = 0; i < te.length; i++) {
      if (te[i].start <= he && te[i].end >= hs) return te[i].aa || 'recoded';
    }
    return null;
  }

  function spanOf(feat) { return feat.end - feat.start; }

  // Choose the most specific feature for display naming: CDS/ORF preferred over
  // gene/mRNA, then smallest span.
  function moreSpecific(a, b) {
    if (!b) return a;
    if (!a) return b;
    var aCoding = (a.type === 'CDS' || a.type === 'ORF');
    var bCoding = (b.type === 'CDS' || b.type === 'ORF');
    if (aCoding !== bCoding) return aCoding ? a : b;
    return spanOf(a) <= spanOf(b) ? a : b;
  }

  // ---- CDS/ORF-driven terminator assignment ----------------------------
  // The authoritative terminator pass. Instead of the old per-hit ±3 tolerance
  // test (which mislabelled coincidental stops sitting 1-3 nt from a gene end as
  // extra "terminators" in compact/AT-rich genomes), each CDS/ORF claims EXACTLY
  // ONE hit: the stop codon at its true 3' end. A CDS's terminator is either
  //   (a) stop-INCLUDED  -- the CDS's own last codon is an in-frame stop under
  //       the feature's genetic code (GenBank/RefSeq/GFF3 convention), or
  //   (b) stop-EXCLUDED  -- if (a) does not hold, the codon immediately 3' of
  //       the CDS is a stop (Ensembl GTF convention).
  // (a) is tried first, so a tandem stop in the very next codon of a
  // stop-INCLUDED CDS is never mis-claimed as a second terminator. A hit that is
  // merely NEAR a boundary but is not a CDS's actual terminating stop is left to
  // its real context (cds-internal-*/intergenic/...). Genuine co-terminal genes
  // that share one stop are preserved: several CDS may claim the same hit (it is
  // still a single terminator hit). Returns a Map: hit -> ARRAY of every CDS/ORF
  // feature that hit terminates (usually one; more than one ONLY for genuine
  // co-terminal shared-stop genes, e.g. phiX174 A/A*, lambda S105/S107) so the
  // per-gene summary can credit each co-terminal gene. Keys use a plain space
  // delimiter (never a NUL/control byte); real seqIds contain no spaces.
  // O(hits + features) with two coordinate hash indexes, so it scales to
  // multi-Mb genomes (E. coli ~9k features / ~360k hits).
  function assignTerminators(hits, features, ctx) {
    var termMap = new Map();
    if (!hits || !hits.length || !features || !features.length) return termMap;

    // Index hits by the forward coordinate of their biological 3' base (the
    // stop-INCLUDED anchor: `end` on '+', `start` on '-') and by the coordinate
    // a CDS 3' terminus would carry if this hit sat immediately after it (the
    // stop-EXCLUDED anchor: `start-1` on '+', `end+1` on '-'). Wrap hits (end <
    // start, origin-crossing) index by their wrapped coords just the same.
    var inclMap = {}, exclMap = {};
    function push(map, key, h) { (map[key] || (map[key] = [])).push(h); }
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var base = h.seqId + ' ' + h.strand + ' ';
      if (h.strand === '-') {
        push(inclMap, base + h.start, h);
        push(exclMap, base + (h.end + 1), h);
      } else {
        push(inclMap, base + h.end, h);
        push(exclMap, base + (h.start - 1), h);
      }
    }

    for (var f = 0; f < features.length; f++) {
      var feat = features[f];
      if (feat.type !== 'CDS' && feat.type !== 'ORF') continue;
      var T = getOrdered(feat).three; // forward coord of the 3'-terminal base
      var keyBase = feat.seqId + ' ' + feat.strand + ' ';
      var chosen = null;

      // (a) stop-INCLUDED: the CDS's last codon is itself the terminating stop.
      var inclCands = inclMap[keyBase + T];
      if (inclCands) {
        for (var a = 0; a < inclCands.length; a++) {
          var hi = inclCands[a];
          if (feat.type === 'CDS' && !isStopInFeature(feat, hi.codon, ctx)) continue;
          if (!inReadingFrame(feat, hi.start, hi.end)) continue;
          chosen = hi; break;
        }
      }
      // (b) stop-EXCLUDED: terminator is the codon immediately 3' of the CDS.
      if (!chosen) {
        var exclCands = exclMap[keyBase + T];
        if (exclCands) {
          for (var b = 0; b < exclCands.length; b++) {
            var he = exclCands[b];
            if (feat.type === 'CDS' && !isStopInFeature(feat, he.codon, ctx)) continue;
            chosen = he; break;
          }
        }
      }
      if (chosen) {
        var arr = termMap.get(chosen);
        if (arr) arr.push(feat); else termMap.set(chosen, [feat]);
      }
    }
    return termMap;
  }

  function classifyHit(hit, index, strict, ctx, termMap) {
    var hs = hit.start, he = hit.end;
    var result = {
      context: 'intergenic',
      geneName: null, locusTag: null, product: null, featureId: null, inFrame: null,
      recodingCandidate: false, recodedAA: null, terminatorFeatureIds: null
    };

    // Precedence 1: terminator, resolved by the CDS/ORF-driven assignment
    // (assignTerminators) instead of a per-hit ±3 test. When a termMap is
    // supplied (always, from annotate) it is AUTHORITATIVE: this hit is a
    // terminator iff one—or several co-terminal—CDS/ORF claimed it as the stop
    // at their true 3' end; otherwise it is NOT a terminator and falls through
    // to its real context below. The legacy per-hit ±3 test further down runs
    // only for standalone classifyHit callers that pass no termMap.
    if (termMap) {
      var claimants = termMap.get(hit);
      if (claimants && claimants.length) {
        // Name the hit after the most specific claiming feature.
        var tf = claimants[0];
        for (var ci = 1; ci < claimants.length; ci++) tf = moreSpecific(claimants[ci], tf);
        result.context = (tf.type === 'ORF') ? 'orf-terminator' : 'cds-terminator';
        applyName(result, tf);
        result.inFrame = true;
        // Genuine CO-TERMINAL genes share ONE stop codon (one terminator hit).
        // Record every CDS/ORF this single hit terminates so the per-gene summary
        // credits each of them; the common single-claimant case keeps just
        // featureId (terminatorFeatureIds stays null).
        if (claimants.length > 1) {
          var ids = [];
          for (var cj = 0; cj < claimants.length; cj++) {
            var fid = claimants[cj].id || claimants[cj].locusTag || claimants[cj].name;
            if (fid != null && ids.indexOf(fid) === -1) ids.push(fid);
          }
          if (ids.length > 1) result.terminatorFeatureIds = ids;
        }
        return result;
      }
    }

    var group = index.groups[keyOf(hit.seqId, hit.strand)];
    if (!group) return result;

    // Origin-wrapping hit (found by the circular scanner): its forward span
    // crosses the origin, so he < hs. Handle it separately -- the normal
    // interval query assumes hs <= he.
    if (he < hs) return classifyWrapHit(hit, group, strict, result, ctx, termMap);

    // Expand the query a little so stop-excluded / adjacent terminators (which
    // sit just outside the CDS) are still discovered.
    var pad = strict ? 1 : 4;
    var segs = querySegments(group, hs - pad, he + pad);
    if (!segs.length) return result;

    // Unique features from the matched segments.
    var featSet = [];
    var seen = {};
    for (var i = 0; i < segs.length; i++) {
      var f = segs[i].feat;
      var fid = f._uid || (f._uid = ('f' + (classifyHit._n = (classifyHit._n || 0) + 1)));
      if (!seen[fid]) { seen[fid] = 1; featSet.push(f); }
    }

    // Legacy per-hit terminator test: ONLY for standalone callers that passed no
    // termMap. The annotate() pipeline always passes one (handled above), so
    // this ±3 fallback never runs there and cannot reintroduce the tolerance
    // artifacts it once produced. Among features whose terminator window the hit
    // falls in, pick the CLOSEST, breaking ties by specificity.
    if (!termMap) {
      var termFeat = null, termIsOrf = false, termBest = Infinity;
      for (var t = 0; t < featSet.length; t++) {
        var ft = featSet[t];
        if (ft.type !== 'CDS' && ft.type !== 'ORF') continue;
        // A hit only terminates a CDS if it is actually a stop in THAT feature's
        // genetic code (e.g. TGA is Trp, not a stop, in a transl_table=4 CDS).
        if (ft.type === 'CDS' && !isStopInFeature(ft, hit.codon, ctx)) continue;
        var d = terminatorDist(ft, hs, he, strict);
        if (d < 0) continue;
        var better = (!termFeat) || (d < termBest) || (d === termBest && moreSpecific(ft, termFeat) === ft);
        if (better) { termBest = d; termFeat = ft; termIsOrf = (ft.type === 'ORF'); }
      }
      if (termFeat) {
        result.context = termIsOrf ? 'orf-terminator' : 'cds-terminator';
        applyName(result, termFeat);
        result.inFrame = true;
        return result;
      }
    }

    // For internal/non-coding tests, restrict to features that actually overlap.
    var overlapping = [];
    for (var o = 0; o < featSet.length; o++) {
      var fo = featSet[o];
      // does the hit truly overlap any of fo's segments?
      if (hs <= fo.end && he >= fo.start && featOverlaps(fo, hs, he)) overlapping.push(fo);
    }
    if (!overlapping.length) return result; // intergenic

    // Precedence 2/3: inside a CDS/ORF -> in/out of frame.
    var bestCds = null;
    for (var c = 0; c < overlapping.length; c++) {
      var fc = overlapping[c];
      if (fc.type === 'CDS' || fc.type === 'ORF') bestCds = moreSpecific(fc, bestCds);
    }
    if (bestCds) {
      var off = codingOffset(bestCds, hs, he);
      var inFrame = (off !== null && (((off - framePhase(bestCds)) % 3) + 3) % 3 === 0);
      result.inFrame = inFrame;
      applyName(result, bestCds);
      if (!inFrame) {
        result.context = 'cds-internal-outframe';
        return result;
      }
      // In-frame internal stop inside a CDS. Three sub-cases, in priority:
      //  (a) a GenBank /transl_except at this position -> a KNOWN recoding
      //      (selenocysteine TGA->Sec, pyrrolysine TAG->Pyl): NOT a premature
      //      stop. Classify 'cds-recoded' so it is excluded from pseudogene
      //      counts and the readthrough-candidate list.
      //  (b) the codon is not a stop in the feature's OWN genetic code (e.g. a
      //      TGA inside a transl_table=4 CDS = Trp): also 'cds-recoded'.
      //  (c) otherwise a genuine in-frame internal stop -> keep the existing
      //      'cds-internal-inframe' context but flag it as a candidate for
      //      readthrough / selenocysteine / programmed frameshift / annotation
      //      or sequencing artifact, so the UI can reframe it (not "broken gene").
      var known = (bestCds.type === 'CDS') ? knownRecoding(bestCds, hs, he) : null;
      if (known) {
        result.context = 'cds-recoded';
        result.recodedAA = known;
      } else if (bestCds.type === 'CDS' && !isStopInFeature(bestCds, hit.codon, ctx)) {
        result.context = 'cds-recoded';
      } else {
        result.context = 'cds-internal-inframe';
        result.recodingCandidate = true;
      }
      return result;
    }

    // Precedence 4: within a non-coding gene/mRNA/tRNA/rRNA.
    var bestNc = null;
    for (var n = 0; n < overlapping.length; n++) {
      if (NONCODING_GENE_TYPES[overlapping[n].type]) bestNc = moreSpecific(overlapping[n], bestNc);
    }
    if (bestNc) {
      result.context = 'within-noncoding-gene';
      applyName(result, bestNc);
      return result;
    }

    return result; // intergenic
  }

  // Classify an origin-wrapping hit (he < hs). Best-effort: label it a
  // terminator only when a wrapping CDS/ORF's biological 3' end coincides with
  // the junction codon; otherwise leave it intergenic. The essential fix is
  // upstream (the circular scanner now *finds* this codon instead of dropping
  // it); precise junction annotation is secondary.
  function classifyWrapHit(hit, group, strict, result, ctx, termMap) {
    // With a termMap, terminator status was already decided authoritatively by
    // the CDS/ORF-driven assignment (checked in classifyHit before we arrive
    // here). A wrap hit reaching this point was not claimed by any CDS/ORF, so
    // it is intergenic — do NOT re-run a ±3 terminator test on it.
    if (termMap) return result;
    var hs = hit.start, he = hit.end;
    var BIG = 1e15;
    var segs = querySegments(group, hs, BIG).concat(querySegments(group, 0, he));
    if (!segs.length) return result;

    var featSet = [], seen = {};
    for (var i = 0; i < segs.length; i++) {
      var f = segs[i].feat;
      var fid = f._uid || (f._uid = ('f' + (classifyHit._n = (classifyHit._n || 0) + 1)));
      if (!seen[fid]) { seen[fid] = 1; featSet.push(f); }
    }

    var tol = strict ? 0 : 3;
    var termFeat = null, termIsOrf = false, best = Infinity;
    for (var t = 0; t < featSet.length; t++) {
      var ft = featSet[t];
      if (ft.type !== 'CDS' && ft.type !== 'ORF') continue;
      if (ft.type === 'CDS' && !isStopInFeature(ft, hit.codon, ctx)) continue;
      var od = getOrdered(ft);
      if (!od.wraps) continue; // only a wrapping gene can terminate at a wrap codon
      var d = Math.min(Math.abs(he - od.three), Math.abs(hs - od.three));
      if (d <= tol && d < best) { best = d; termFeat = ft; termIsOrf = (ft.type === 'ORF'); }
    }
    if (termFeat) {
      result.context = termIsOrf ? 'orf-terminator' : 'cds-terminator';
      applyName(result, termFeat);
      result.inFrame = true;
    }
    return result;
  }

  function featOverlaps(feat, hs, he) {
    for (var i = 0; i < feat.segments.length; i++) {
      var sg = feat.segments[i];
      if (sg.end >= hs && sg.start <= he) return true;
    }
    return false;
  }

  function applyName(result, feat) {
    result.geneName = feat.name || null;
    result.locusTag = feat.locusTag || null;
    result.product = feat.product || null;
    result.featureId = feat.id || feat.locusTag || feat.name || null;
  }

  function annotate(hits, features, options) {
    options = options || {};
    var strict = !!options.strict;
    var chunk = options.chunk || 20000;
    var onProgress = options.onProgress || function () {};
    var isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : function () { return false; };
    var yieldFn = (global.CodonScanner && global.CodonScanner.makeYield)
      ? global.CodonScanner.makeYield()
      : function (cb) { global.setTimeout(cb, 0); };

    // Genetic-code context: the global run table plus a per-feature stop-set
    // cache, so per-feature /transl_table is honored during classification.
    var ctx = {
      tableId: (options.tableId != null) ? options.tableId
                : (global.CodonTables ? global.CodonTables.DEFAULT_ID : null)
    };

    return new Promise(function (resolve, reject) {
      try {
        var index = buildIndex(features);
        hits = hits || [];
        // One authoritative CDS/ORF-driven terminator pass up front: each CDS/ORF
        // claims its single true 3'-terminal stop (see assignTerminators). The
        // per-hit classification below just reads this map, so terminators are
        // exact and never over-counted by boundary-adjacent coincidental stops.
        var termMap = assignTerminators(hits, features, ctx);
        var i = 0;
        var total = hits.length;

        function step() {
          if (isCancelled()) { resolve(); return; }
          var end = Math.min(i + chunk, total);
          for (; i < end; i++) {
            var h = hits[i];
            var c = classifyHit(h, index, strict, ctx, termMap);
            h.context = c.context;
            h.geneName = c.geneName;
            h.locusTag = c.locusTag;
            h.product = c.product;
            h.featureId = c.featureId;
            h.inFrame = c.inFrame;
            h.recodingCandidate = c.recodingCandidate;
            h.recodedAA = c.recodedAA;
            // Only co-terminal terminator hits carry this (shared stop -> several
            // CDS); leave every other hit's shape unchanged (no new export field).
            if (c.terminatorFeatureIds) h.terminatorFeatureIds = c.terminatorFeatureIds;
          }
          onProgress({ done: i, total: total });
          if (i >= total) { resolve(); return; }
          yieldFn(step);
        }
        if (total === 0) { resolve(); return; }
        step();
      } catch (err) {
        reject(err);
      }
    });
  }

  global.CodonAnnotate = {
    buildIndex: buildIndex,
    querySegments: querySegments,
    assignTerminators: assignTerminators,
    classifyHit: classifyHit,
    annotate: annotate
  };
})(typeof window !== 'undefined' ? window : this);
