/*
 * scanner.js -- Six-frame stop codon scanning for Stop Codon Finder.
 *
 * Exposes a global `CodonScanner` object. All coordinate math is 1-based,
 * inclusive, and always reported in FORWARD-strand coordinates, even for
 * reverse-strand hits.
 *
 * ---------------------------------------------------------------------------
 * WORKED EXAMPLE (reverse-strand coordinate mapping) -- read this before
 * touching the math below.
 *
 *   Forward strand (5'->3'):   C  C  C  T  T  A  G  G  G     length L = 9
 *   0-based index:             0  1  2  3  4  5  6  7  8
 *
 *   Complement each base (A<->T, C<->G), keeping the SAME order:
 *                               G  G  G  A  A  T  C  C  C
 *
 *   Reverse that to get the reverse complement (RC), read 5'->3':
 *     RC[j] = complement(forward[L - 1 - j])
 *                               C  C  C  T  A  A  G  G  G
 *   RC 0-based index:          0  1  2  3  4  5  6  7  8
 *
 *   RC[3..5] = "T A A" -> a stop codon (TAA) starting at RC index j = 3.
 *
 *   To report this hit in forward-strand coordinates, note that RC index j
 *   corresponds to forward index (L - 1 - j), so a 3-base codon starting at
 *   RC index j covers forward indices:
 *       (L-1-j), (L-2-j), (L-3-j)   <- in DEcreasing order as j increases
 *   i.e. the covered forward window (0-based, ascending) is:
 *       [ L-3-j , L-2-j , L-1-j ]
 *
 *   With L = 9, j = 3:
 *       forward window (0-based) = [3, 4, 5]  ->  forward[3..5] = "T T A"
 *       (sanity check: reverse-complement of "TTA" is "TAA" -- matches RC[3..5])
 *
 *   Converting the 0-based forward window to 1-based inclusive coordinates:
 *       start = (L - 3 - j) + 1 = L - 2 - j = 9 - 2 - 3 = 4
 *       end   = (L - 1 - j) + 1 = L - j     = 9 - 3     = 6
 *
 *   So this hit is reported as: start=4, end=6, strand="-".
 *   (Forward 1-based positions 4-6 are exactly forward[3..5] above.)
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // The only three DNA stop codons, mapped to their classic names.
  var STOP_CODONS = {
    TAA: 'ochre',
    TAG: 'amber',
    TGA: 'opal'
  };

  // Standard complement map. IUPAC ambiguity codes get a sensible
  // complement where one is well defined; anything unrecognized (including
  // 'N') is left unchanged rather than throwing.
  var COMPLEMENT = {
    A: 'T', T: 'A', C: 'G', G: 'C',
    R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
    B: 'V', V: 'B', D: 'H', H: 'D', N: 'N'
  };

  function complementBase(ch) {
    var c = COMPLEMENT[ch];
    return c || ch; // unknown character: keep as-is, never throw
  }

  // ---- IUPAC ambiguity resolution --------------------------------------
  // A codon that contains an ambiguity code is a DEFINITE stop iff EVERY
  // A/C/G/T resolution of that codon is a stop. So `TAR` (= TAA or TAG) and
  // `TRA` (= TAA or TGA) are stops under the standard code, but `TGN` is not
  // (TGG=Trp). This matches how EMBOSS resolves ambiguity and prevents both
  // false negatives (missing TAR) and false positives (calling TGN).
  var IUPAC = {
    A: 'A', C: 'C', G: 'G', T: 'T',
    R: 'AG', Y: 'CT', S: 'GC', W: 'AT', K: 'GT', M: 'AC',
    B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT'
  };
  var AMBIG_RE = /[RYSWKMBDHVN]/;

  function expandCodon(codon) {
    var a = IUPAC[codon.charAt(0)], b = IUPAC[codon.charAt(1)], c = IUPAC[codon.charAt(2)];
    if (!a || !b || !c) return null; // contains a truly unknown character
    var out = [];
    for (var i = 0; i < a.length; i++)
      for (var j = 0; j < b.length; j++)
        for (var k = 0; k < c.length; k++)
          out.push(a.charAt(i) + b.charAt(j) + c.charAt(k));
    return out;
  }

  // Non-enumerable per-stop-set cache so we never re-expand a codon and never
  // pollute Object.keys(stops) (report.js iterates the stop set).
  function ambigCacheFor(stops) {
    if (!Object.prototype.hasOwnProperty.call(stops, '__ambigCache')) {
      Object.defineProperty(stops, '__ambigCache',
        { value: {}, enumerable: false, writable: true, configurable: true });
    }
    return stops.__ambigCache;
  }

  // Returns the stop "name" if `codon` (which must contain >=1 ambiguity code)
  // resolves to a stop under every disambiguation; otherwise undefined. Pure
  // A/C/G/T codons return undefined here (they are handled by the direct
  // stops[codon] lookup in the caller).
  function resolveAmbiguousStop(codon, stops) {
    if (!AMBIG_RE.test(codon)) return undefined;
    var cache = ambigCacheFor(stops);
    if (codon in cache) return cache[codon];
    var res;
    var exp = expandCodon(codon);
    if (exp && exp.length) {
      var name = null, all = true;
      for (var i = 0; i < exp.length; i++) {
        var n = stops[exp[i]];
        if (!n) { all = false; break; }
        if (name === null) name = n; else if (name !== n) name = 'stop';
      }
      if (all) res = name;
    }
    cache[codon] = res;
    return res;
  }

  // Look up a codon against the stop set, resolving ambiguity codes when the
  // record is known to contain any. `recHasAmbig` short-circuits the common
  // case (no ambiguity in the record) to zero extra cost.
  function stopNameFor(codon, stops, recHasAmbig) {
    var name = stops[codon];
    if (name === undefined && recHasAmbig) name = resolveAmbiguousStop(codon, stops);
    return name;
  }

  // ---- Central coordinate helper ---------------------------------------
  // ONE place that owns the scanner's coordinate conventions so every consumer
  // (scan loops, ORF post-pass, exports, future BED/GFF3 output) agrees.
  //   - All hit start/end are 1-based, inclusive, forward-strand, start<=end
  //     (except origin-wrapping circular hits, where end<start).
  //   - forwardWindow(i): a forward-strand codon starting at 0-based index i.
  //   - reverseWindow(j,L): a reverse-strand codon at 0-based RC index j maps
  //     back to forward 1-based coords (see the worked example at top of file).
  //   - toBed(hit): 0-based half-open [start,end) for BED/genome-browser output.
  var coords = {
    forwardWindow: function (i) { return { start: i + 1, end: i + 3 }; },
    reverseWindow: function (j, L) { return { start: L - 2 - j, end: L - j }; },
    toBed: function (hit) {
      // Origin-crossing (wrapping) hits are not a single half-open interval.
      if (hit.end < hit.start) return null;
      return { chromStart: hit.start - 1, chromEnd: hit.end };
    }
  };

  // Assign a stable, zero-padded per-hit id (stop_0001, stop_0002, ...) in the
  // hits' current order. Call once after the scan (and any sort) so every
  // consumer/export references the same id.
  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }
  function assignHitIds(hits, prefix) {
    hits = hits || [];
    prefix = prefix || 'stop_';
    var width = Math.max(4, String(hits.length).length);
    for (var i = 0; i < hits.length; i++) hits[i].id = prefix + pad(i + 1, width);
    return hits;
  }

  // Count bases that are N or an IUPAC ambiguity code in a sequence.
  function countAmbiguous(seq) {
    var n = 0;
    for (var i = 0; i < seq.length; i++) {
      var ch = seq.charAt(i);
      if (ch !== 'A' && ch !== 'C' && ch !== 'G' && ch !== 'T') n++;
    }
    return n;
  }

  /** Reverse complement of a normalized (uppercase) DNA string. */
  function reverseComplement(seq) {
    var L = seq.length;
    var out = new Array(L);
    for (var i = 0; i < L; i++) {
      out[L - 1 - i] = complementBase(seq.charAt(i));
    }
    return out.join('');
  }

  /** Synchronous forward-strand scan of a single sequence (all 3 frames). */
  function findStopCodonsForward(seq, seqId, stopCodons) {
    var stops = stopCodons || STOP_CODONS;
    var hasAmbig = AMBIG_RE.test(seq);
    var hits = [];
    var L = seq.length;
    for (var i = 0; i + 3 <= L; i++) {
      var codon = seq.charAt(i) + seq.charAt(i + 1) + seq.charAt(i + 2);
      var name = stopNameFor(codon, stops, hasAmbig);
      if (name) {
        var w = coords.forwardWindow(i);
        hits.push({
          seqId: seqId,
          start: w.start,
          end: w.end,
          strand: '+',
          frame: (i % 3) + 1, // 1, 2, or 3 -> displayed as +1/+2/+3
          codon: codon,
          name: name
        });
      }
    }
    return hits;
  }

  /** Synchronous reverse-strand scan of a single sequence (all 3 frames). */
  function findStopCodonsReverse(seq, seqId, stopCodons) {
    var stops = stopCodons || STOP_CODONS;
    var rc = reverseComplement(seq);
    var hasAmbig = AMBIG_RE.test(rc);
    var hits = [];
    var L = seq.length;
    for (var j = 0; j + 3 <= L; j++) {
      var codon = rc.charAt(j) + rc.charAt(j + 1) + rc.charAt(j + 2);
      var name = stopNameFor(codon, stops, hasAmbig);
      if (name) {
        var w = coords.reverseWindow(j, L); // see worked example above
        hits.push({
          seqId: seqId,
          start: w.start,
          end: w.end,
          strand: '-',
          frame: (j % 3) + 1, // 1, 2, or 3 -> displayed as -1/-2/-3
          codon: codon,
          name: name
        });
      }
    }
    return hits;
  }

  /** Synchronous, both-strand, all-six-frames scan. Handy for small inputs/tests. */
  function findStopCodons(seq, seqId, stopCodons) {
    return findStopCodonsForward(seq, seqId, stopCodons)
      .concat(findStopCodonsReverse(seq, seqId, stopCodons));
  }

  // Wrap a 1-based coordinate into the range 1..L (for origin-crossing codons
  // on a circular replicon).
  function wrap1(x, L) {
    return ((x - 1) % L + L) % L + 1;
  }

  // Scan the (up to 4) stop codons that straddle the origin of a CIRCULAR
  // record -- the linear passes only cover codons fully inside [1..L], so these
  // junction codons would otherwise be silently missed on both strands. Uses
  // the exact same coordinate formulas as the linear scan, then wraps the
  // reported start/end into 1..L; a hit whose reported end < start is flagged
  // `wraps:true` and marks an origin-crossing codon.
  function scanWrapJunction(rec, stopCodons) {
    var hits = [];
    var seq = rec.seq;
    var L = seq.length;
    if (L < 3) return hits;
    var stops = stopCodons || STOP_CODONS;
    var hasAmbig = AMBIG_RE.test(seq);

    // Forward: codons starting at 0-based L-2 and L-1 wrap the origin.
    for (var d = 2; d >= 1; d--) {
      var i = L - d;
      if (i < 0) continue;
      var codon = seq.charAt(i) + seq.charAt((i + 1) % L) + seq.charAt((i + 2) % L);
      var name = stopNameFor(codon, stops, hasAmbig);
      if (name) {
        hits.push({
          seqId: rec.id, start: wrap1(i + 1, L), end: wrap1(i + 3, L),
          strand: '+', frame: (i % 3) + 1, codon: codon, name: name, wraps: true
        });
      }
    }

    // Reverse: same junction on the reverse complement.
    var rc = reverseComplement(seq);
    for (var dj = 2; dj >= 1; dj--) {
      var j = L - dj;
      if (j < 0) continue;
      var rcodon = rc.charAt(j) + rc.charAt((j + 1) % L) + rc.charAt((j + 2) % L);
      var rname = stopNameFor(rcodon, stops, hasAmbig);
      if (rname) {
        hits.push({
          seqId: rec.id, start: wrap1(L - 2 - j, L), end: wrap1(L - j, L),
          strand: '-', frame: (j % 3) + 1, codon: rcodon, name: rname, wraps: true
        });
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------------
  // Chunked / async orchestrator so the UI never freezes, even on large
  // (multi-megabase) inputs. Deliberately splits the work into six
  // per-(strand,frame) tasks per sequence -- this is the SAME total number
  // of codon checks as two full passes (one forward, one reverse), just
  // bucketed by frame, which lets us report granular progress such as
  // "Scanning frame +2 of contig 3 of 5...".
  // ---------------------------------------------------------------------

  function buildTasks(records) {
    var tasks = [];
    for (var r = 0; r < records.length; r++) {
      if (records[r].seq.length < 3) continue; // nothing to scan
      var strands = ['+', '-'];
      for (var s = 0; s < strands.length; s++) {
        for (var f = 0; f < 3; f++) {
          tasks.push({ recordIndex: r, strand: strands[s], frameIdx: f });
        }
      }
    }
    return tasks;
  }

  /**
   * Scan every record across all six reading frames, yielding control back
   * to the browser between chunks so the tab stays responsive and a
   * progress bar can update.
   *
   * @param {Array<{id:string, seq:string}>} records
   * @param {Object} [options]
   * @param {number} [options.codonsPerSlice=40000] codon checks per UI slice
   * @param {function} [options.onProgress] called with a progress info object
   * @returns {Promise<{hits: Array, totalBasesScanned: number}>}
   */
  // Factory for the chunk-yield helper. We deliberately AVOID
  // requestAnimationFrame: browsers pause rAF callbacks entirely while a tab is
  // hidden/backgrounded, which would freeze a long scan the moment the user
  // switches tabs. A MessageChannel postMessage is not throttled in background
  // tabs and still yields to the event loop (so the progress bar repaints when
  // visible); setTimeout(0) is the fallback for environments without
  // MessageChannel. This is the SAME behavior scanAll has always used, factored
  // out so annotate/render loops can share it (see build brief C9).
  function makeYield() {
    if (typeof global.MessageChannel === 'function') {
      var _mc = new global.MessageChannel();
      var _queue = [];
      _mc.port1.onmessage = function () {
        var cb = _queue.shift();
        if (cb) cb();
      };
      return function (cb) { _queue.push(cb); _mc.port2.postMessage(0); };
    }
    return function (cb) { global.setTimeout(cb, 0); };
  }

  function scanAll(records, options) {
    options = options || {};
    var codonsPerSlice = options.codonsPerSlice || 40000;
    var onProgress = options.onProgress || function () {};
    // Configurable stop-codon set (build brief hard rule 4). Defaults to the
    // built-in map so current behavior is byte-identical when the option is
    // absent.
    var stopCodons = options.stopCodons || STOP_CODONS;
    var isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : function () { return false; };

    var yieldFn = makeYield();

    return new Promise(function (resolve, reject) {
      try {
        var validRecords = (records || []).filter(function (r) {
          return r && typeof r.seq === 'string';
        });

        // scannedUnits increments by 3 per codon over six frame-passes (~6*L for
        // a length-L record), so the declared total must be length*6 for the
        // reported fraction to track real work instead of overshooting ~3x.
        var totalUnits = 0;
        var recHasAmbig = [];        // per-record: contains N/ambiguity code?
        var ambiguousBaseCount = 0;  // total N/ambiguity bases across all records
        for (var i = 0; i < validRecords.length; i++) {
          totalUnits += validRecords[i].seq.length * 6;
          var na = countAmbiguous(validRecords[i].seq);
          ambiguousBaseCount += na;
          recHasAmbig[i] = na > 0;
        }

        if (validRecords.length === 0 || totalUnits === 0) {
          resolve({ hits: [], totalBasesScanned: 0, ambiguousBaseCount: 0 });
          return;
        }

        var tasks = buildTasks(validRecords);
        if (tasks.length === 0) {
          resolve({ hits: [], totalBasesScanned: 0, ambiguousBaseCount: ambiguousBaseCount });
          return;
        }

        var allHits = [];
        var scannedUnits = 0;
        var taskIdx = 0;
        var pos = 0; // codon start offset within the active task's scan string
        var rcCache = {}; // recordIndex -> cached reverse-complement string

        function stringForTask(task) {
          var rec = validRecords[task.recordIndex];
          if (task.strand === '+') return rec.seq;
          if (rcCache[task.recordIndex] === undefined) {
            rcCache[task.recordIndex] = reverseComplement(rec.seq);
          }
          return rcCache[task.recordIndex];
        }

        function step() {
          if (isCancelled()) {
            resolve({ hits: allHits, totalBasesScanned: scannedUnits, cancelled: true });
            return;
          }
          if (taskIdx >= tasks.length) {
            // Circular replicons: add the origin-crossing junction codons that
            // the linear passes cannot form. Cheap (<=4 codons per record).
            for (var wr = 0; wr < validRecords.length; wr++) {
              if (validRecords[wr].circular) {
                var wrapHits = scanWrapJunction(validRecords[wr], stopCodons);
                for (var wh = 0; wh < wrapHits.length; wh++) allHits.push(wrapHits[wh]);
              }
            }
            resolve({ hits: allHits, totalBasesScanned: scannedUnits, ambiguousBaseCount: ambiguousBaseCount });
            return;
          }

          var task = tasks[taskIdx];
          var rec = validRecords[task.recordIndex];
          var str = stringForTask(task);
          var L = str.length;
          var hasAmbig = recHasAmbig[task.recordIndex];

          if (pos === 0) pos = task.frameIdx; // first slice of this task starts at the frame offset

          var checked = 0;
          while (pos + 3 <= L && checked < codonsPerSlice) {
            var codon = str.charAt(pos) + str.charAt(pos + 1) + str.charAt(pos + 2);
            var name = stopNameFor(codon, stopCodons, hasAmbig);
            if (name) {
              if (task.strand === '+') {
                var wf = coords.forwardWindow(pos);
                allHits.push({
                  seqId: rec.id, start: wf.start, end: wf.end,
                  strand: '+', frame: task.frameIdx + 1, codon: codon, name: name
                });
              } else {
                var wr = coords.reverseWindow(pos, L);
                allHits.push({
                  seqId: rec.id, start: wr.start, end: wr.end,
                  strand: '-', frame: task.frameIdx + 1, codon: codon, name: name
                });
              }
            }
            pos += 3;
            checked++;
            scannedUnits += 3;
          }

          onProgress({
            recordId: rec.id,
            recordIndex: task.recordIndex,
            recordCount: validRecords.length,
            strand: task.strand,
            frameNumber: task.frameIdx + 1,
            taskIndex: taskIdx,
            taskCount: tasks.length,
            hitsSoFar: allHits.length,
            scannedUnits: scannedUnits,
            totalUnits: totalUnits,
            percent: totalUnits > 0 ? Math.min(100, Math.round((scannedUnits / totalUnits) * 100)) : 100
          });

          if (pos + 3 > L) {
            taskIdx++;
            pos = 0;
          }

          yieldFn(step);
        }

        step();
      } catch (err) {
        reject(err);
      }
    });
  }

  global.CodonScanner = {
    STOP_CODONS: STOP_CODONS,
    complementBase: complementBase,
    reverseComplement: reverseComplement,
    resolveAmbiguousStop: resolveAmbiguousStop,
    findStopCodonsForward: findStopCodonsForward,
    findStopCodonsReverse: findStopCodonsReverse,
    findStopCodons: findStopCodons,
    buildTasks: buildTasks,
    makeYield: makeYield,
    scanAll: scanAll,
    coords: coords,
    assignHitIds: assignHitIds
  };
})(typeof window !== 'undefined' ? window : this);
