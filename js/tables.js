/*
 * tables.js -- NCBI genetic-code tables for Stop Codon Finder.
 *
 * Exposes a global `CodonTables` object (plain, non-module, no network) so it
 * works identically from file:// and https://.
 *
 * Public API:
 *   CodonTables.DEFAULT_ID -> 11
 *   CodonTables.list()      -> [{id,name,stops:[codon...],starts:[codon...]}, ...]
 *   CodonTables.get(id)     -> {id,name,stops,starts, translate(codon)->aaChar}
 *   CodonTables.stopSet(id) -> {CODON:name}   // ready for scanAll options.stopCodons
 *   CodonTables.altStarts(id) -> [codon...]   // alternative start codons for a table
 *   CodonTables.organismToTable(str) -> id|null // guess an NCBI table from an
 *                                               // organism name / header keywords
 *
 * Full 64-codon tables are stored as the Standard (table 1) baseline plus a
 * small per-table diff, exactly as NCBI publishes them.
 */
(function (global) {
  'use strict';

  // NCBI translation strings (order = Base1/Base2/Base3 below).
  var BASE1 = 'TTTTTTTTTTTTTTTTCCCCCCCCCCCCCCCCAAAAAAAAAAAAAAAAGGGGGGGGGGGGGGGG';
  var BASE2 = 'TTTTCCCCAAAAGGGGTTTTCCCCAAAAGGGGTTTTCCCCAAAAGGGGTTTTCCCCAAAAGGGG';
  var BASE3 = 'TCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAGTCAG';
  // Standard code (transl_table 1) amino acids, aligned to the codon order above.
  var AA_STANDARD = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';

  // Build the ordered list of 64 codons once.
  var CODON_ORDER = (function () {
    var arr = [];
    for (var i = 0; i < 64; i++) {
      arr.push(BASE1.charAt(i) + BASE2.charAt(i) + BASE3.charAt(i));
    }
    return arr;
  })();

  // Per-table definitions. `diffs` are codon->aa overrides on top of Standard.
  // `altStarts` are the extra start codons beyond ATG exposed by the toggle
  // (NCBI `Starts` line, minus ATG). `ambiguousStops` lists codons that in this
  // code are read as sense OR stop depending on context (tables 27/28/31); they
  // are DELIBERATELY excluded from the definite stop set built from `diffs`, so
  // the tool never hard-calls a context-dependent stop from sequence alone.
  // `note` is surfaced in the UI for context-dependent codes.
  //
  // All codon<->AA assignments follow NCBI "The Genetic Codes" (gc.prt); DNA
  // alphabet (T, not U). Stops are DERIVED from `diffs` (codons whose AA is '*'),
  // never hard-coded, so single-stop (6/14/33) and non-canonical-stop
  // (22=TCA, 23=TTA, 2=AGA/AGG) codes are handled automatically.
  var DEFS = {
    1:  { name: 'Standard',
          diffs: {},                                          altStarts: ['TTG', 'CTG'] },
    2:  { name: 'Vertebrate Mitochondrial',
          diffs: { AGA: '*', AGG: '*', ATA: 'M', TGA: 'W' }, altStarts: ['ATA', 'ATT', 'ATC', 'GTG'] },
    3:  { name: 'Yeast Mitochondrial',
          diffs: { ATA: 'M', CTT: 'T', CTC: 'T', CTA: 'T', CTG: 'T', TGA: 'W' }, altStarts: ['ATA', 'GTG'] },
    4:  { name: 'Mold/Protozoan/Mycoplasma',
          diffs: { TGA: 'W' },                                altStarts: ['TTA', 'TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'GTG'] },
    5:  { name: 'Invertebrate Mitochondrial',
          diffs: { AGA: 'S', AGG: 'S', ATA: 'M', TGA: 'W' }, altStarts: ['TTG', 'GTG', 'ATA', 'ATT', 'ATC'] },
    6:  { name: 'Ciliate/Dasycladacean/Hexamita',
          diffs: { TAA: 'Q', TAG: 'Q' },                     altStarts: [] },
    9:  { name: 'Echinoderm/Flatworm Mitochondrial',
          diffs: { AAA: 'N', AGA: 'S', AGG: 'S', TGA: 'W' }, altStarts: ['GTG'] },
    10: { name: 'Euplotid Nuclear',
          diffs: { TGA: 'C' },                                altStarts: [] },
    11: { name: 'Bacterial/Archaeal/Plastid',
          diffs: {},                                          altStarts: ['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'GTG'] },
    12: { name: 'Alternative Yeast Nuclear',
          diffs: { CTG: 'S' },                                altStarts: ['CTG'] },
    13: { name: 'Ascidian Mitochondrial',
          diffs: { AGA: 'G', AGG: 'G', ATA: 'M', TGA: 'W' }, altStarts: ['TTG', 'GTG', 'ATA'] },
    14: { name: 'Alternative Flatworm Mitochondrial',
          diffs: { AAA: 'N', AGA: 'S', AGG: 'S', TAA: 'Y', TGA: 'W' }, altStarts: [] },
    16: { name: 'Chlorophycean Mitochondrial',
          diffs: { TAG: 'L' },                                altStarts: [] },
    21: { name: 'Trematode Mitochondrial',
          diffs: { TGA: 'W', ATA: 'M', AAA: 'N', AGA: 'S', AGG: 'S' }, altStarts: ['GTG'] },
    22: { name: 'Scenedesmus obliquus Mitochondrial',
          diffs: { TCA: '*', TAG: 'L' },                     altStarts: [] },
    23: { name: 'Thraustochytrium Mitochondrial',
          diffs: { TTA: '*' },                                altStarts: ['ATT', 'GTG'] },
    24: { name: 'Rhabdopleuridae Mitochondrial',
          diffs: { AGA: 'S', AGG: 'K', TGA: 'W' },           altStarts: ['GTG', 'CTG', 'TTG'] },
    25: { name: 'Candidate Division SR1/Gracilibacteria',
          diffs: { TGA: 'G' },                                altStarts: ['GTG', 'TTG'] },
    26: { name: 'Pachysolen tannophilus Nuclear',
          diffs: { CTG: 'A' },                                altStarts: ['CTG'] },
    27: { name: 'Karyorelict Nuclear',
          diffs: { TAA: 'Q', TAG: 'Q' },                     altStarts: [],
          ambiguousStops: ['TAA', 'TAG'],
          note: 'Context-dependent code: TAA/TAG are read as Gln OR stop depending on ' +
                'context and cannot be called from sequence alone. Only TGA is a definite stop.' },
    28: { name: 'Condylostoma Nuclear',
          diffs: { TAA: 'Q', TAG: 'Q', TGA: 'W' },           altStarts: [],
          ambiguousStops: ['TAA', 'TAG', 'TGA'],
          note: 'Context-dependent code: all three of TAA/TAG/TGA are read as sense OR stop ' +
                'depending on context. No codon can be called a definite stop from sequence alone.' },
    31: { name: 'Blastocrithidia Nuclear',
          diffs: { TAA: 'E', TAG: 'E', TGA: 'W' },           altStarts: [],
          ambiguousStops: ['TAA', 'TAG'],
          note: 'Context-dependent code: TAA/TAG are read as Glu OR stop depending on ' +
                'context and cannot be called from sequence alone; TGA reads as Trp.' },
    33: { name: 'Cephalodiscidae Mitochondrial',
          diffs: { TAA: 'Y', AGA: 'S', AGG: 'K', TGA: 'W' }, altStarts: ['GTG', 'TTG'] }
  };

  // Deterministic display order for the UI select. Context-dependent codes
  // (27/28/31) are listed last so the common set leads.
  var ORDER = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 16, 21, 22, 23, 24, 25, 26, 33, 27, 28, 31];

  var DEFAULT_ID = 11;

  var STOP_NAME = { TAA: 'ochre', TAG: 'amber', TGA: 'opal' };

  // Cache of fully-built table objects keyed by id.
  var CACHE = {};

  function buildAaMap(id) {
    var def = DEFS[id] || DEFS[1];
    var map = {};
    for (var i = 0; i < CODON_ORDER.length; i++) {
      map[CODON_ORDER[i]] = AA_STANDARD.charAt(i);
    }
    var diffs = def.diffs || {};
    for (var codon in diffs) {
      if (Object.prototype.hasOwnProperty.call(diffs, codon)) {
        map[codon] = diffs[codon];
      }
    }
    return map;
  }

  function build(id) {
    if (CACHE[id]) return CACHE[id];
    if (!DEFS[id]) id = DEFAULT_ID;
    var def = DEFS[id];
    var aaMap = buildAaMap(id);

    var stops = [];
    for (var i = 0; i < CODON_ORDER.length; i++) {
      var c = CODON_ORDER[i];
      if (aaMap[c] === '*') stops.push(c);
    }

    var starts = ['ATG'].concat(def.altStarts || []);

    var table = {
      id: id,
      name: def.name,
      stops: stops,               // DEFINITE stops only (AA === '*')
      starts: ['ATG'],           // default starts (conservative, ATG-only)
      altStarts: (def.altStarts || []).slice(),
      allStarts: starts,          // ATG + alternatives
      ambiguousStops: (def.ambiguousStops || []).slice(), // context-dependent
      ambiguous: !!(def.ambiguousStops && def.ambiguousStops.length),
      note: def.note || null,
      aaMap: aaMap,
      translate: function (codon) {
        if (!codon || codon.length !== 3) return 'X';
        var aa = aaMap[codon.toUpperCase()];
        return aa === undefined ? 'X' : aa;
      }
    };
    CACHE[id] = table;
    return table;
  }

  function get(id) {
    return build(Number(id));
  }

  function list() {
    return ORDER.map(function (id) {
      var t = build(id);
      return {
        id: id, name: t.name, stops: t.stops.slice(), starts: t.allStarts.slice(),
        ambiguous: t.ambiguous, ambiguousStops: t.ambiguousStops.slice(), note: t.note
      };
    });
  }

  // Definite stop set for the scanner: {CODON:name}. Only codons that are
  // ALWAYS a stop in this code (never the context-dependent ambiguous ones).
  function stopSet(id) {
    var t = build(Number(id));
    var set = {};
    for (var i = 0; i < t.stops.length; i++) {
      var c = t.stops[i];
      set[c] = STOP_NAME[c] || 'stop';
    }
    return set;
  }

  // Context-dependent stops for tables 27/28/31: {CODON:'ambiguous'}. These are
  // NEVER placed in the definite stopSet; exposed separately so the UI can offer
  // an opt-in "also flag ambiguous stops" view without ever hard-calling them.
  function ambiguousStopSet(id) {
    var t = build(Number(id));
    var set = {};
    for (var i = 0; i < t.ambiguousStops.length; i++) set[t.ambiguousStops[i]] = 'ambiguous';
    return set;
  }

  function altStarts(id) {
    return build(Number(id)).altStarts.slice();
  }

  /**
   * organismToTable(str) -> supported NCBI table id, or null when nothing
   * recognizable is found. This is the ONE shared organism-string -> table
   * mapping used by BOTH the header/keyword auto-detection (Task 1) and the
   * user-typed "Organism" control (Task 3), so the two paths can never drift.
   *
   * `str` may be a single organism name (e.g. "Homo sapiens") or a blob of
   * concatenated header text (FASTA headers + GenBank DEFINITION/SOURCE/
   * ORGANISM lines). Matching is substring/keyword based and deliberately
   * CONSERVATIVE: we only return a non-null id when a keyword strongly implies
   * a genetic code, and rule ORDER encodes priority so the most specific signal
   * wins (organellar/endosymbiont codes before generic nuclear/bacterial ones).
   *
   * Only ids present in this build's ORDER (1,2,4,5,6,11,25) are ever returned.
   */
  function organismToTable(str) {
    if (str == null) return null;
    var s = String(str).toLowerCase();
    if (!s.trim()) return null;

    // A sequence explicitly marked bacterial / archaeal / plastid / phage /
    // endosymbiont uses the Bacterial-Archaeal-Plastid code (table 11). We
    // compute this up front because such a marker describes the SEQUENCED
    // organism even when a host name is also present: e.g. "Bacterial
    // endosymbiont of Paramecium bursaria" is a bacterium (11), NOT the host
    // ciliate (6). "endosymbiont" / "candidatus" are near-always uncultured
    // bacteria/archaea. (The bundled Lambda phage example is caught here via
    // "phage", so no fragile bare "lambda" keyword is needed -- that keyword
    // was removed because it mis-mapped human immunoglobulin-lambda sequences.)
    var bacterialLike = /chloroplast|plastid|cyanobacter|\bbacteri|archae|\bphage\b|endosymbiont|candidatus|escherichia|\be\.?\s*coli\b|\bcoli\b|salmonella|bacillus|pseudomonas|streptococc|staphylococc|klebsiella|mycobacter|\bvibrio\b|clostridi/.test(s);

    // 1) Mitochondrial genomes. "mitochond" is the trigger; pick the vertebrate
    //    table (2) by default and the invertebrate table (5) only when an
    //    invertebrate lineage is also named. Kept conservative on purpose.
    //    Invertebrate keywords are word-boundaried (e.g. "\bbutterfly\b") so a
    //    vertebrate whose name merely CONTAINS one -- "butterflyfish" is a fish
    //    -- is not mis-mapped to the invertebrate table.
    if (/mitochond/.test(s)) {
      if (/invertebrate|insect|arthropod|drosophila|mosquito|\bfly\b|beetle|mollusc|mollusk|nematode|\bworm\b|annelid|crustacean|arachnid|\bbee\b|\bant\b|\bbutterfly\b|\bmoth/.test(s)) {
        return 5;  // Invertebrate Mitochondrial
      }
      return 2;    // Vertebrate Mitochondrial (default for mitochondria)
    }

    // 2) Mycoplasma / Spiroplasma / Ureaplasma clade (TGA = Trp) -> table 4.
    if (/mycoplasma|spiroplasma|ureaplasma|mesoplasma|entomoplasma|mollicut/.test(s)) {
      return 4;
    }

    // 3) Ciliates with reassigned TAA/TAG -> Gln (table 6). Named genera plus a
    //    generic "ciliate" keyword -- but only when the text is NOT also flagged
    //    bacterial-like, so a bacterium/endosymbiont that merely names a ciliate
    //    HOST does not inherit the ciliate code.
    if (!bacterialLike && /tetrahymena|paramecium|oxytricha|stylonychia|\bciliate/.test(s)) {
      return 6;
    }

    // 4) Chloroplast / plastid / cyanobacteria and bacterial / archaeal / phage /
    //    endosymbiont sequences all use the Bacterial-Archaeal-Plastid code
    //    (table 11). Computed as `bacterialLike` above so rule 3 can defer to it.
    if (bacterialLike) {
      return 11;
    }

    // 5) Common eukaryotic NUCLEAR genomes use the Standard code (table 1).
    //    Checked AFTER organelle/bacterial keywords so e.g. "Arabidopsis
    //    chloroplast" resolves to 11 rather than 1.
    if (/homo sapiens|\bhuman\b|mus musculus|\bmouse\b|rattus|\brat\b|saccharomyces|cerevisiae|\byeast\b|arabidopsis|drosophila|caenorhabditis|elegans|danio|zebrafish|xenopus|gallus|\bsapiens\b/.test(s)) {
      return 1;
    }

    return null;
  }

  global.CodonTables = {
    DEFAULT_ID: DEFAULT_ID,
    STOP_NAME: STOP_NAME,
    list: list,
    get: get,
    stopSet: stopSet,
    ambiguousStopSet: ambiguousStopSet,
    altStarts: altStarts,
    organismToTable: organismToTable
  };
})(typeof window !== 'undefined' ? window : this);
