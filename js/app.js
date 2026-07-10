/*
 * app.js -- UI orchestration for Stop Codon Finder.
 *
 * Owns: dual-slot file loading (FASTA / GFF3 / GenBank, single or pair) with
 * content auto-detection, scan-settings wiring (mode / genetic code / min-ORF),
 * the ScanProgress-driven scan pipeline (scan -> ORF -> annotate -> summarize ->
 * chunked render), the results table with Gene/Context columns and filters, the
 * per-gene summary, downloads, theme, and a realistic progress+ETA panel.
 *
 * Codes strictly against the logic-layer globals: CodonTables, CodonInput,
 * CodonScanner, CodonAnnotate, CodonORF, CodonReport, ScanProgress. All loaded
 * as plain (non-module) scripts before this file. No network, file:// safe.
 */
(function (global, document) {
  'use strict';

  var MAX_TABLE_ROWS = 5000;
  var RENDER_CHUNK = 500;
  var DEFAULT_TABLE_ID = (global.CodonTables && global.CodonTables.DEFAULT_ID) || 11;

  var CONTEXT_META = {
    'cds-terminator':        { label: 'CDS terminator',            cls: 'ctx-cds-terminator' },
    'cds-internal-inframe':  { label: 'In-frame internal stop (readthrough candidate)', cls: 'ctx-cds-internal-inframe' },
    'cds-recoded':           { label: 'Recoded (Sec/Pyl or per-CDS code)', cls: 'ctx-cds-recoded' },
    'cds-internal-outframe': { label: 'Within CDS (out-of-frame)', cls: 'ctx-cds-internal-outframe' },
    'within-noncoding-gene': { label: 'Non-coding gene',           cls: 'ctx-within-noncoding-gene' },
    'intergenic':            { label: 'Intergenic',                cls: 'ctx-intergenic' },
    'orf-terminator':        { label: 'ORF terminator',            cls: 'ctx-orf-terminator' }
  };

  var state = {
    files: [],            // [{name, text, size, kind}]
    records: [],
    features: [],         // matched annotation features from dispatch
    runFeatures: [],      // features actually used in the last run (may include ORFs)
    annotationActive: false,  // context columns active (may include synthetic ORFs)
    hasAnnotation: false,     // real annotation was loaded (drives settings summary)
    hasCDS: false,
    autoTableId: null,
    activeTableId: DEFAULT_TABLE_ID,
    tableUserSet: false,
    // Translation-table precedence inputs (highest wins): manual dropdown
    // (tableUserSet) > organism control > declared transl_table > header
    // keyword guess > default. resolveTable() combines these.
    userOrganism: '',         // free-text from the Organism control
    organismTableId: null,    // organismToTable(userOrganism)
    declaredTableId: null,    // single consistent transl_table from the file
    headerTableId: null,      // guessed from FASTA/GenBank header organism text
    tableSource: 'default',   // 'user'|'organism'|'declared'|'header'|'default'
    codeNoteDismissed: false, // user dismissed the current provenance note
    mode: 'all',          // 'all' | 'coding'
    modeUserSet: false,
    minOrfCodons: 30,
    altStarts: false,
    requireStart: true,   // ORF definition: true = start-to-stop (default), false = stop-to-stop
    hits: [],
    displayHits: [],
    summary: null,
    geneSummary: [],
    columns: [],
    runId: 0,
    scanning: false,
    vizRecordId: null,     // which sequence the genome-map card is showing
    vizSvgs: {},           // { frame|density|circular : <svg> } for figure export
    fileBaseName: 'stop_codon_report',
    sort: { key: 'start', dir: 'asc' },
    geneSort: { key: 'internalStops', dir: 'desc' },
    colorScheme: (global.CodonPalettes && global.CodonPalettes.DEFAULT_ID) || 'colourblind-safe'
  };

  function $(id) { return document.getElementById(id); }
  function fmtInt(n) { return Number(n).toLocaleString(); }

  // Count-up on the summary stat values when results first appear. Preserves the
  // formatted prefix/suffix ("1,234 bp", "45.2%", "2.13 /kb"). No-ops under
  // reduced-motion, when the tab is hidden, or for very large result sets.
  function animateStatCounts() {
    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var big = state.summary && state.summary.totalStops > 20000;
    var vals = document.querySelectorAll('#stat-grid .stat-value');
    if (reduce || document.hidden || big) return;      // leave final text as-is
    vals.forEach(function (el) {
      var full = el.textContent;
      var m = full.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
      if (!m) return;
      var pre = m[1], suf = m[3];
      var decimals = (m[2].split('.')[1] || '').length;
      var target = parseFloat(m[2].replace(/,/g, ''));
      if (!isFinite(target)) return;
      var t0 = performance.now(), dur = 650;
      el.textContent = pre + '0' + (decimals ? '.' + '0'.repeat(decimals) : '') + suf;
      function step(now) {
        var k = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - k, 3);                // easeOutCubic
        var v = target * e;
        var s = decimals ? v.toFixed(decimals) : Math.round(v).toLocaleString();
        el.textContent = pre + s + suf;
        if (k < 1 && !document.hidden) requestAnimationFrame(step);
        else el.textContent = full;                    // snap to exact final string
      }
      requestAnimationFrame(step);
    });
  }

  // ====================================================================
  // Theme
  // ====================================================================

  function currentEffectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    return (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function updateThemeIcon() {
    var eff = currentEffectiveTheme();
    $('theme-toggle-icon').textContent = eff === 'dark' ? '☀️' : '🌙';
    $('theme-toggle').setAttribute('aria-pressed', eff === 'dark' ? 'true' : 'false');
    $('theme-toggle').setAttribute('aria-label', eff === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  function initTheme() {
    var saved = null;
    try { saved = global.localStorage.getItem('scf-theme'); } catch (e) {}
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon();
  }
  function toggleTheme() {
    var next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { global.localStorage.setItem('scf-theme', next); } catch (e) {}
    updateThemeIcon();
    // Re-stamp the active codon scheme for the new theme. The scheme is applied
    // as INLINE custom properties on <html>, which override the stylesheet's
    // theme blocks, so it must be re-applied whenever the theme flips.
    applyColorScheme();
    // Re-render color-driven visuals so codon/context hues track the theme.
    if (state.summary) { renderStatCards(); renderFrameBreakdown(); renderResultsTable(); renderViz(); }
  }

  // ====================================================================
  // Codon colour scheme (palettes.js registry, persisted like the theme)
  // ====================================================================

  var COLOR_SCHEME_KEY = 'scf-color-scheme';

  // Stamp the active scheme's --codon-* / --codon-*-ink onto <html> for the
  // current effective theme.
  function applyColorScheme() {
    if (!global.CodonPalettes) return;
    global.CodonPalettes.apply(state.colorScheme, currentEffectiveTheme());
  }

  function initColorScheme() {
    var sel = $('scheme-select');
    if (!global.CodonPalettes) { if (sel) sel.parentNode.hidden = true; return; }
    var saved = null;
    try { saved = global.localStorage.getItem(COLOR_SCHEME_KEY); } catch (e) {}
    if (saved && global.CodonPalettes.has(saved)) state.colorScheme = saved;
    if (sel) {
      sel.innerHTML = '';
      global.CodonPalettes.list().forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.label;
        if (s.note) opt.title = s.note;
        sel.appendChild(opt);
      });
      sel.value = state.colorScheme;
      sel.addEventListener('change', function () { setColorScheme(sel.value); });
    }
    applyColorScheme();
  }

  function setColorScheme(id) {
    if (!global.CodonPalettes || !global.CodonPalettes.has(id)) return;
    state.colorScheme = id;
    try { global.localStorage.setItem(COLOR_SCHEME_KEY, id); } catch (e) {}
    applyColorScheme();
    // Everything on screen paints via var(--codon-*); re-render the colour-driven
    // views so any cached SVG/markup repaints immediately.
    if (state.summary) { renderStatCards(); renderFrameBreakdown(); renderResultsTable(); renderViz(); }
    announce('Colour scheme: ' + (global.CodonPalettes.get(id).label || id));
  }

  // ====================================================================
  // Messages
  // ====================================================================

  function showError(msg) { $('error-message').textContent = msg; $('error-banner').hidden = false; }
  function clearError() { $('error-banner').hidden = true; }
  function showWarning(msg) { $('warning-message').textContent = msg; $('warning-banner').hidden = false; }
  function addWarning(msg) {
    var el = $('warning-message');
    el.textContent = (el.textContent && !$('warning-banner').hidden) ? (el.textContent + ' ' + msg) : msg;
    $('warning-banner').hidden = false;
  }
  function clearWarning() { $('warning-banner').hidden = true; }
  function showInfo(msg) { $('info-message').textContent = msg; $('info-banner').hidden = false; }
  function clearInfo() { $('info-banner').hidden = true; }
  function showSuccess(msg) { $('success-message').textContent = msg; $('success-banner').hidden = false; }
  function clearSuccess() { $('success-banner').hidden = true; }
  function clearMessages() { clearError(); clearWarning(); clearInfo(); clearSuccess(); }

  function announce(msg) {
    var region = $('live-region');
    region.textContent = '';
    global.setTimeout(function () { region.textContent = msg; }, 50);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], val = bytes, i = -1;
    do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
    return val.toFixed(val < 10 ? 2 : 1) + ' ' + units[i];
  }
  function formatClock(ms) {
    var totalSec = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(totalSec / 60), s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var debounceTimer = null;
  function debouncedRescan() {
    if (debounceTimer) global.clearTimeout(debounceTimer);
    debounceTimer = global.setTimeout(function () { if (state.records.length) runScan(); }, 260);
  }

  // ====================================================================
  // File loading (dual-slot, auto-detected)
  // ====================================================================

  function fileRole(kind) { return kind === 'gff-no-fasta' ? 'annotation' : 'sequence'; }
  function formatLabel(kind) {
    switch (kind) {
      case 'fasta': return 'FASTA';
      case 'genbank': return 'GenBank';
      case 'gff-with-fasta': return 'GFF3 + FASTA';
      case 'gff-no-fasta': return 'GFF3';
      default: return 'Raw';
    }
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve({ name: file.name, text: String(r.result), size: file.size }); };
      r.onerror = function () { reject(r.error || new Error('read error')); };
      r.readAsText(file);
    });
  }

  function handleFileList(fileList) {
    var files = [];
    for (var i = 0; i < fileList.length && i < 2; i++) files.push(fileList[i]);
    if (fileList.length > 2) showWarning('More than two files were provided; using the first two.');
    Promise.all(files.map(readFile)).then(function (objs) {
      addFiles(objs);
    }).catch(function (err) {
      showError('Could not read a file' + (err && err.message ? ': ' + err.message : '.'));
    });
  }

  // Merge new files by role: a new sequence replaces the old sequence, a new
  // annotation replaces the old annotation. Lets a user drop a pair together OR
  // add a GFF3 to an already-loaded FASTA.
  function addFiles(objs) {
    clearMessages();
    objs.forEach(function (f) { f.kind = global.CodonInput.detect(f.text); });
    objs.forEach(function (nf) {
      var role = fileRole(nf.kind);
      state.files = state.files.filter(function (ef) { return fileRole(ef.kind) !== role; });
      state.files.push(nf);
    });
    if (state.files.length > 2) state.files = state.files.slice(-2);
    processLoaded();
  }

  function loadExample(kind) {
    var objs = [];
    if (kind === 'fasta') {
      objs = [{ name: global.SAMPLE_FASTA_FILENAME, text: global.SAMPLE_FASTA_TEXT, size: global.SAMPLE_FASTA_TEXT.length }];
    } else if (kind === 'pair') {
      objs = [
        { name: global.SAMPLE_PAIR_FASTA_FILENAME, text: global.SAMPLE_PAIR_FASTA_TEXT, size: global.SAMPLE_PAIR_FASTA_TEXT.length },
        { name: global.SAMPLE_PAIR_GFF_FILENAME, text: global.SAMPLE_PAIR_GFF_TEXT, size: global.SAMPLE_PAIR_GFF_TEXT.length }
      ];
    } else if (kind === 'genbank') {
      objs = [{ name: global.SAMPLE_GENBANK_FILENAME, text: global.SAMPLE_GENBANK_TEXT, size: global.SAMPLE_GENBANK_TEXT.length }];
    } else if (kind === 'lambda') {
      objs = [{ name: global.SAMPLE_LAMBDA_FILENAME, text: global.SAMPLE_LAMBDA_TEXT, size: global.SAMPLE_LAMBDA_TEXT.length }];
    } else if (kind === 'phix') {
      objs = [{ name: global.SAMPLE_PHIX_FILENAME, text: global.SAMPLE_PHIX_TEXT, size: global.SAMPLE_PHIX_TEXT.length }];
    } else if (kind === 'ms2') {
      objs = [{ name: global.SAMPLE_MS2_FILENAME, text: global.SAMPLE_MS2_TEXT, size: global.SAMPLE_MS2_TEXT.length }];
    } else if (kind === 'mito') {
      objs = [{ name: global.SAMPLE_MITO_FILENAME, text: global.SAMPLE_MITO_TEXT, size: global.SAMPLE_MITO_TEXT.length }];
    } else if (kind === 'n4') {
      objs = [{ name: global.SAMPLE_N4_FILENAME, text: global.SAMPLE_N4_TEXT, size: global.SAMPLE_N4_TEXT.length }];
    }
    // Examples replace whatever is loaded.
    state.files = [];
    objs.forEach(function (f) { f.kind = global.CodonInput.detect(f.text); });
    state.files = objs;
    clearMessages();
    processLoaded();
  }

  function supportedTableIds() {
    return global.CodonTables.list().map(function (t) { return t.id; });
  }

  // ====================================================================
  // Translation-table precedence (Tasks 1, 3, 4)
  // ====================================================================

  // Gather organism-bearing text from the loaded files: FASTA headers ('>' lines)
  // and GenBank DEFINITION / SOURCE / ORGANISM lines. We scan the raw file text
  // directly (headers are few and cheap) and cap the amount inspected so a huge
  // FASTA can't stall the UI.
  function collectHeaderText() {
    var CAP = 200000; // inspect at most ~200 KB per file for header lines
    var pieces = [];
    state.files.forEach(function (f) {
      var text = (f.text || '').slice(0, CAP);
      var lines = text.split(/\r\n|\r|\n/);
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        if (ln.charAt(0) === '>') { pieces.push(ln.slice(1)); continue; }
        // GenBank organism-bearing lines (DEFINITION/SOURCE at col 0, ORGANISM indented)
        var m = /^(?:DEFINITION|SOURCE)\s+(.+)$/.exec(ln) || /^\s+ORGANISM\s+(.+)$/.exec(ln);
        if (m) pieces.push(m[1]);
      }
    });
    return pieces.join(' \n ');
  }

  // (4) Guess a table id from header keywords via the shared mapping. Returns a
  // supported id or null. A declared transl_table always beats this guess.
  function detectHeaderTable() {
    var blob = collectHeaderText();
    if (!blob.trim()) return null;
    var id = global.CodonTables.organismToTable(blob);
    if (id != null && supportedTableIds().indexOf(id) !== -1) return id;
    return null;
  }

  // Fold the precedence chain into state.activeTableId + state.tableSource and
  // refresh the dropdown, captions and the dismissible provenance note.
  // Precedence (highest first): user manual dropdown > organism control >
  // declared transl_table > header keyword guess > default table 11.
  function resolveTable() {
    if (state.tableUserSet) {
      state.tableSource = 'user';
    } else if (state.organismTableId != null) {
      state.activeTableId = state.organismTableId; state.tableSource = 'organism';
    } else if (state.declaredTableId != null) {
      state.activeTableId = state.declaredTableId; state.tableSource = 'declared';
    } else if (state.headerTableId != null) {
      state.activeTableId = state.headerTableId; state.tableSource = 'header';
    } else {
      state.activeTableId = DEFAULT_TABLE_ID; state.tableSource = 'default';
    }

    var sel = $('table-select');
    if (sel && sel.options.length) sel.value = state.activeTableId;
    updateStopsCaption();
    updateSettingsSummary();
    buildCodeNote();
  }

  function tableLabel(id) {
    return 'Table ' + id + ' (' + global.CodonTables.get(id).name + ')';
  }

  // Build and show the dismissible provenance/conflict note describing WHAT set
  // the active table and WHY, and flag any lower-precedence source that
  // disagrees rather than overriding it silently.
  function buildCodeNote() {
    var note = $('code-note');
    var textEl = $('code-note-text');
    if (!note || !textEl) return;

    var active = state.activeTableId;
    var declared = state.declaredTableId;
    var header = state.headerTableId;
    var org = state.userOrganism;
    var declaredDisagrees = (declared != null && declared !== active);
    var conflict = false;
    var msg;

    switch (state.tableSource) {
      case 'user':
        msg = 'Using ' + tableLabel(active) + ' — your manual choice. This overrides any auto-detection.';
        // If a stronger auto-signal disagrees, note it (informational only).
        if (state.organismTableId != null && state.organismTableId !== active) {
          conflict = true;
          msg += ' (You indicated "' + org + '" → ' + tableLabel(state.organismTableId) + ', but your manual choice wins.)';
        } else if (declaredDisagrees) {
          conflict = true;
          msg += ' (The file declares transl_table=' + declared + ', but your manual choice wins.)';
        }
        break;
      case 'organism':
        if (declaredDisagrees) {
          conflict = true;
          msg = 'You indicated "' + org + '" → ' + tableLabel(active) + ', but the file declares transl_table=' +
            declared + ' — using ' + tableLabel(active) + ' from your organism; change the code above if needed.';
        } else {
          msg = 'You indicated "' + org + '" → ' + tableLabel(active) + '; genetic code set accordingly.';
        }
        break;
      case 'declared':
        msg = 'The file declares transl_table=' + declared + ' → ' + tableLabel(active) + '; genetic code set accordingly. You can override it above.';
        if (header != null && header !== active) {
          msg += ' (Header keywords suggested ' + tableLabel(header) + ', but the declared value takes priority.)';
        }
        break;
      case 'header':
        msg = 'Detected a likely organism from the file headers → ' + tableLabel(active) + '. No transl_table was declared; override above if this is wrong.';
        break;
      default:
        msg = 'No genetic code was declared or detected — using the default ' + tableLabel(DEFAULT_TABLE_ID) +
          '. Set your organism or pick a translation table above if needed.';
    }

    textEl.textContent = msg;
    note.classList.toggle('conflict', conflict);
    note.hidden = !!state.codeNoteDismissed;
  }

  function dismissCodeNote() {
    state.codeNoteDismissed = true;
    $('code-note').hidden = true;
  }

  function processLoaded() {
    clearMessages();
    var dispatch = global.CodonInput.dispatch(state.files);

    if (dispatch.warnings && dispatch.warnings.length) showWarning(dispatch.warnings.join(' '));

    if (dispatch.errors && dispatch.errors.length) {
      state.records = [];
      state.features = dispatch.features || [];
      renderSlots();
      $('slots').hidden = false;
      $('load-footer').hidden = false;
      $('settings-section').hidden = true;
      showResultsSection(false);
      showProgressPanel(false);
      showError(dispatch.errors.join(' '));
      return;
    }

    state.records = dispatch.records;
    state.features = dispatch.features || [];
    state.hasCDS = state.features.some(function (f) { return f.type === 'CDS'; });
    state.hasAnnotation = state.features.length > 0;
    state.annotationActive = state.features.length > 0;

    // Fresh load: reset user-override flags and pick sensible defaults.
    state.tableUserSet = false;
    state.modeUserSet = false;
    state.activeTableId = DEFAULT_TABLE_ID;
    // Default to the coding view (the real gene-terminating stops — one per CDS)
    // whenever the input carries CDS annotation: that is what most users open an
    // annotated genome to see, and the ±8,400 six-frame chance triplets bury it.
    // With no annotation there is nothing to terminate, so default to showing
    // EVERY stop codon in all six frames. The "All stop codons" toggle is always
    // one click away.
    state.mode = state.hasCDS ? 'coding' : 'all';

    // Fresh load clears the manual organism (a new file should re-detect).
    state.userOrganism = '';
    state.organismTableId = null;
    state.codeNoteDismissed = false;
    state.vizRecordId = null; // let renderViz default to the first record

    // (3) transl_table declared in the file -- single consistent value only.
    state.autoTableId = null;
    state.declaredTableId = null;
    var declared = {};
    state.features.forEach(function (f) { if (f.translTable != null) declared[f.translTable] = 1; });
    var declaredIds = Object.keys(declared);
    if (declaredIds.length === 1) {
      var n = Number(declaredIds[0]);
      if (supportedTableIds().indexOf(n) !== -1) {
        state.declaredTableId = n;
        state.autoTableId = n; // preserved for any legacy reference
      }
    } else if (declaredIds.length > 1) {
      // Mixed transl_table declarations across contigs: the tool applies one
      // global genetic code, so warn that the default is used for all.
      addWarning('Annotation declares more than one genetic code (transl_table=' +
        declaredIds.sort(function (a, b) { return a - b; }).join(', ') + '). This tool applies a single ' +
        'code to every contig, so the default (' + global.CodonTables.get(DEFAULT_TABLE_ID).name +
        ', table ' + DEFAULT_TABLE_ID + ') is used. Set the correct code below if needed.');
    }

    // (4) Organism keywords auto-detected from FASTA/GenBank header text.
    state.headerTableId = detectHeaderTable();

    // Fold the precedence chain into an active table + provenance note.
    resolveTable();

    renderSlots();
    $('slots').hidden = false;
    $('load-footer').hidden = false;
    buildSettingsUI();
    $('settings-section').hidden = false;

    runScan();
  }

  function seqStats() {
    var bp = 0;
    state.records.forEach(function (r) { bp += r.seq.length; });
    return { count: state.records.length, bp: bp };
  }

  function renderSlots() {
    var seqFile = null, annFile = null;
    state.files.forEach(function (f) {
      if (!seqFile && fileRole(f.kind) === 'sequence') seqFile = f;
    });
    state.files.forEach(function (f) {
      if (f !== seqFile && f.kind === 'gff-no-fasta') annFile = f;
    });
    var seqCarries = seqFile && (seqFile.kind === 'genbank' || seqFile.kind === 'gff-with-fasta');

    var ss = seqStats();
    var cdsCount = state.features.filter(function (f) { return f.type === 'CDS'; }).length;
    var featCount = state.features.length;
    function annotationStatusHTML() {
      if (featCount > 0) {
        var label = cdsCount > 0 ? (fmtInt(cdsCount) + ' CDS feature' + (cdsCount === 1 ? '' : 's'))
          : (fmtInt(featCount) + ' feature' + (featCount === 1 ? '' : 's'));
        return { cls: 'ok', text: 'Annotation found — ' + label };
      }
      return { cls: 'neutral', text: 'No annotation' };
    }

    // ---- Slot A: Sequence ----
    var a = $('slot-a'); var aBody = $('slot-a-body');
    if (seqFile) {
      a.className = 'slot filled';
      aBody.innerHTML = fileCardHTML(seqFile, {
        metaText: ss.count > 0 ? (fmtInt(ss.count) + ' sequence' + (ss.count === 1 ? '' : 's') + ', ' + fmtInt(ss.bp) + ' bp') : 'No sequence found',
        status: seqCarries ? annotationStatusHTML() : null,
        role: 'sequence'
      });
    } else {
      a.className = 'slot';
      aBody.innerHTML = '<div class="slot-empty">No sequence file yet. Drop a FASTA, GenBank, or GFF3-with-##FASTA file.</div>';
    }

    // ---- Slot B: Annotation ----
    var b = $('slot-b'); var bBody = $('slot-b-body');
    if (annFile) {
      b.className = 'slot filled';
      bBody.innerHTML = fileCardHTML(annFile, { metaText: null, status: annotationStatusHTML(), role: 'annotation' });
    } else if (seqCarries) {
      b.className = 'slot filled disabled';
      var st = annotationStatusHTML();
      bBody.innerHTML = '<div class="slot-file"><div class="slot-status ' + st.cls + '"><span class="dot dot-ok"></span>' +
        escapeHtml(st.text) + '</div><div class="slot-meta">Embedded in ' + escapeHtml(seqFile.name) + '</div></div>';
    } else {
      b.className = 'slot disabled';
      bBody.innerHTML = '<div class="slot-empty">Optional. Add a GFF3 to classify hits by gene / CDS and enable coding-stop mode.</div>';
    }

    // Wire per-slot Replace buttons.
    var replaceBtns = document.querySelectorAll('[data-replace]');
    for (var i = 0; i < replaceBtns.length; i++) {
      replaceBtns[i].addEventListener('click', function () { $('file-input').click(); });
    }
  }

  function fileCardHTML(f, opts) {
    var parts = ['<div class="slot-file">'];
    parts.push('<div class="slot-file-top">');
    parts.push('<span class="slot-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>');
    parts.push('<span class="format-badge">' + formatLabel(f.kind) + '</span>');
    parts.push('<span class="slot-size">' + formatBytes(f.size) + '</span>');
    parts.push('</div>');
    if (opts.metaText) parts.push('<div class="slot-meta">' + escapeHtml(opts.metaText) + '</div>');
    if (opts.status) {
      var dot = opts.status.cls === 'ok' ? '<span class="dot dot-ok"></span>' : '';
      parts.push('<div class="slot-status ' + opts.status.cls + '">' + dot + escapeHtml(opts.status.text) + '</div>');
    }
    parts.push('<div class="slot-actions"><button type="button" class="btn btn-ghost btn-sm" data-replace="' + opts.role + '">Replace</button></div>');
    parts.push('</div>');
    return parts.join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ====================================================================
  // Settings UI
  // ====================================================================

  function buildSettingsUI() {
    // Genetic-code select
    var sel = $('table-select');
    if (!sel.options.length) {
      global.CodonTables.list().forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.id;
        o.textContent = 'Table ' + t.id + ' — ' + t.name +
          (t.ambiguous ? ' (context-dependent stops)' : '');
        sel.appendChild(o);
      });
    }
    sel.value = state.activeTableId;
    updateStopsCaption();

    // Organism control reflects current state (cleared on fresh load).
    if ($('organism-input')) $('organism-input').value = state.userOrganism || '';

    // Mode segmented control
    updateModeUI();
    updateMinOrfVisibility();
    updateOrfModeUI();
    updateSettingsSummary();

    // Min-ORF values
    $('minorf-slider').value = Math.min(150, state.minOrfCodons);
    $('minorf-number').value = state.minOrfCodons;
    $('alt-starts-toggle').checked = state.altStarts;
  }

  function updateStopsCaption() {
    var tbl = global.CodonTables.get(state.activeTableId);
    var txt = 'Stops: ' + (tbl.stops.length ? tbl.stops.join(', ') : '(none — context-dependent)');
    if (tbl.ambiguous && tbl.ambiguousStops.length) {
      txt += ' · context-dependent: ' + tbl.ambiguousStops.join(', ');
    }
    $('table-stops-caption').textContent = txt;
  }

  function updateModeUI() {
    var btns = $('mode-group').querySelectorAll('.seg');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === state.mode;
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
      btns[i].tabIndex = on ? 0 : -1;
    }
    $('mode-hint').textContent = state.mode === 'coding'
      ? (state.hasCDS ? 'Show only stops that terminate an annotated CDS.'
                      : 'Predict ORFs and show only their terminating stops.')
      : 'Report every stop codon in all six frames.';
  }

  function updateMinOrfVisibility() {
    $('minorf-setting').hidden = !(state.mode === 'coding' && !state.hasCDS);
  }

  // Reflect the ORF-definition choice: select value, the stop-to-stop
  // disclaimer, and de-emphasise the (now irrelevant) alt-starts control.
  function updateOrfModeUI() {
    var stopToStop = state.requireStart === false;
    var sel = $('orf-mode-select');
    if (sel) sel.value = stopToStop ? 'stop' : 'start';
    var disc = $('orf-mode-disclaimer');
    if (disc) disc.hidden = !stopToStop;
    var note = $('altstarts-ignored-note');
    if (note) note.hidden = !stopToStop;
    var wrap = $('altstarts-wrap');
    var altInput = $('alt-starts-toggle');
    if (altInput) altInput.disabled = stopToStop;
    if (wrap) {
      if (stopToStop) wrap.classList.add('is-disabled');
      else wrap.classList.remove('is-disabled');
    }
  }

  function updateSettingsSummary() {
    var parts = [];
    parts.push(state.mode === 'coding' ? 'Scanning coding stops only' : 'Scanning all stop codons');
    parts.push('using NCBI table ' + state.activeTableId + ' (' + global.CodonTables.get(state.activeTableId).name + ')');
    var tail;
    if (state.hasAnnotation) {
      var cds = state.features.filter(function (f) { return f.type === 'CDS'; }).length;
      tail = cds > 0 ? ('from annotation — ' + fmtInt(cds) + ' CDS feature' + (cds === 1 ? '' : 's'))
                     : ('from annotation — ' + fmtInt(state.features.length) + ' feature(s)');
    } else if (state.mode === 'coding') {
      var orfKind = state.requireStart === false ? 'stop-to-stop' : 'start-to-stop';
      tail = 'predicting ' + orfKind + ' ORFs (min ' + state.minOrfCodons + ' codons)';
    } else {
      tail = 'no annotation loaded';
    }
    $('settings-summary').textContent = parts.join(', ') + ' — ' + tail + '.';
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    state.modeUserSet = true;
    updateModeUI();
    updateMinOrfVisibility();
    updateSettingsSummary();
    debouncedRescan();
  }

  // ====================================================================
  // Scan pipeline
  // ====================================================================

  function showProgressPanel(v) { $('progress-section').hidden = !v; }
  function showResultsSection(v) { $('results-section').hidden = !v; }

  function activeStopSet() { return global.CodonTables.stopSet(state.activeTableId); }
  function activeStops() { return global.CodonTables.get(state.activeTableId).stops; }

  function runScan() {
    if (!state.records.length) return;
    state.runId++;
    var myId = state.runId;
    state.scanning = true;
    clearError(); clearSuccess(); clearInfo();
    // keep any warning from load visible

    var mode = state.mode;
    var tableId = state.activeTableId;
    var stopSet = activeStopSet();
    var baseFeatures = state.features.slice();
    var hasCDS = state.hasCDS;

    var totalBases = 0;
    state.records.forEach(function (r) { totalBases += r.seq.length; });
    var textChars = 0;
    state.files.forEach(function (f) { textChars += f.text.length; });

    var isCancelled = function () { return myId !== state.runId; };

    showProgressPanel(true);
    global.ScanProgress.begin({ fileBytes: textChars, textChars: textChars, totalBases: totalBases });

    // Files are already read + parsed in memory; report those bands as done.
    global.ScanProgress.enter('read', textChars); global.ScanProgress.report('read', textChars);
    global.ScanProgress.enter('parse', textChars); global.ScanProgress.report('parse', textChars);

    global.ScanProgress.enter('scan', totalBases * 6);
    global.CodonScanner.scanAll(state.records, {
      stopCodons: stopSet,
      isCancelled: isCancelled,
      onProgress: function (info) { if (isCancelled()) return; global.ScanProgress.report('scan', info.scannedUnits); }
    }).then(function (scanResult) {
      if (isCancelled()) return;
      var hits = scanResult.hits;
      // Stable, zero-padded per-hit ids (stop_0001, ...) in scan order, shared
      // by the table, CSV and JSON exports.
      global.CodonScanner.assignHitIds(hits);
      state.ambiguousBaseCount = scanResult.ambiguousBaseCount || 0;
      global.ScanProgress.rescaleTail(hits.length);

      var features = baseFeatures;
      if (mode === 'coding' && !hasCDS) {
        var orf = global.CodonORF.predict(state.records, hits, {
          tableId: tableId,
          minLenNt: Math.max(1, state.minOrfCodons) * 3,
          // ORF definition: start-to-stop (needs an initiator) vs stop-to-stop
          // (every open reading frame). Minimum length filters both.
          requireStart: state.requireStart !== false,
          // ATG-only by default (ORFfinder/EMBOSS); alt starts are opt-in and
          // only meaningful in start-to-stop mode (ignored when requireStart is false).
          includeAltStarts: !!state.altStarts
        });
        features = baseFeatures.concat(orf.features);
      }

      var annotatePromise;
      if (features.length) {
        global.ScanProgress.enter('annot', hits.length);
        annotatePromise = global.CodonAnnotate.annotate(hits, features, {
          tableId: tableId, // honor per-feature /transl_table during classification
          isCancelled: isCancelled,
          onProgress: function (p) { if (isCancelled()) return; global.ScanProgress.report('annot', p.done); }
        });
      } else {
        annotatePromise = Promise.resolve();
      }

      return annotatePromise.then(function () {
        if (isCancelled()) return;
        finishPipeline(hits, features, tableId, stopSet, myId);
      });
    }).catch(function (err) {
      if (isCancelled()) return;
      showProgressPanel(false);
      state.scanning = false;
      showError('Scanning failed: ' + (err && err.message ? err.message : String(err)));
    });
  }

  function finishPipeline(hits, features, tableId, stopSet, myId) {
    state.hits = hits;
    state.runFeatures = features;
    state.annotationActive = features.length > 0;

    state.displayHits = (state.mode === 'coding')
      ? hits.filter(function (h) { return h.context === 'cds-terminator' || h.context === 'orf-terminator'; })
      : hits;

    global.ScanProgress.enter('summ', hits.length);
    state.summary = global.CodonReport.buildSummary(state.displayHits, state.records, { stopCodons: stopSet });
    global.ScanProgress.report('summ', hits.length);

    state.geneSummary = global.CodonReport.buildGeneSummary(hits, features);

    // Warn when N/ambiguity bases fell inside scanned codons (they may hide or
    // create stops). Definite ambiguous stops like TAR were still resolved.
    if (state.ambiguousBaseCount > 0) {
      addWarning(fmtInt(state.ambiguousBaseCount) + ' ambiguous/N base(s) were present; codons that could be a stop under every resolution (e.g. TAR) were counted, others were skipped.');
    }

    // Genetic-code sanity nudge: only meaningful with real CDS annotation, and
    // never for context-dependent codes (their internal "stops" are expected).
    var activeTbl = global.CodonTables.get(state.activeTableId);
    state.codeSanity = null;
    if (state.hasCDS && !(activeTbl && activeTbl.ambiguous)) {
      var sanity = global.CodonReport.geneticCodeSanity(state.geneSummary);
      state.codeSanity = sanity;
    }
    // Surface the note attached to context-dependent codes (tables 27/28/31).
    if (activeTbl && activeTbl.note) addWarning(activeTbl.note);

    setupResultColumns();
    populateCodonFilter();
    updateFilterVisibility();
    renderStatCards();
    renderFrameBreakdown();
    renderCodonLegend();
    renderGeneSummary();
    updateSanityNudge();
    updateReadthroughNote();
    updateExportButtons();
    buildVizRecordSelect();
    renderViz();
    showResultsSection(true);
    animateStatCounts();

    var rows = getFilteredSortedDisplayHits().slice(0, MAX_TABLE_ROWS);
    global.ScanProgress.enter('render', Math.max(1, rows.length));
    renderResultsTableChunked(rows, myId, function () {
      if (myId !== state.runId) return;
      global.ScanProgress.finish();
      showProgressPanel(false);
      state.scanning = false;
      updateTableNote();
      announceSuccess();
    });
  }

  function announceSuccess() {
    var n = state.displayHits.length;
    var ss = seqStats();
    if (n === 0) {
      showInfo('No stops found for this configuration.' +
        (state.mode === 'coding' ? ' Try switching to "All stop codons" to widen the search.' : ''));
      announce('Scan complete: no stop codons found.');
      return;
    }
    var msg = fmtInt(n) + ' ' + (state.mode === 'coding' ? 'coding ' : '') + 'stop codon' + (n === 1 ? '' : 's') +
      ' found across ' + fmtInt(ss.count) + ' sequence' + (ss.count === 1 ? '' : 's') + '.';
    showSuccess(msg);
    announce('Scan complete: ' + msg);
  }

  function cancelScan() {
    if (!state.scanning) return;
    state.runId++;            // invalidates the in-flight run
    state.scanning = false;
    global.ScanProgress.cancel();
    showProgressPanel(false);
    showInfo('Scan cancelled.');
    announce('Scan cancelled.');
  }

  // ====================================================================
  // Progress panel DOM
  // ====================================================================

  var lastStageText = '', lastBucket = -1;
  function wireProgress() {
    global.ScanProgress.onUpdate(function (p) {
      $('progress-percent').textContent = p.percentInt;
      $('progress-fill').style.width = p.percentInt + '%';
      var bar = $('progressbar');
      bar.setAttribute('aria-valuenow', p.percentInt);
      bar.classList.toggle('indeterminate', !!p.indeterminate);
      $('progress-heading').textContent = p.percentInt >= 100 ? 'Done' : 'Scanning…';
      $('progress-elapsed').textContent = formatClock(p.elapsedMs);
      $('progress-throughput').textContent = p.throughputText || '—';
      $('progress-eta').textContent = p.indeterminate ? 'estimating…' : (p.etaText || '');
      if (p.phaseLabel !== lastStageText) {
        lastStageText = p.phaseLabel;
        $('progress-stage').textContent = p.phaseLabel;
      }
      var bucket = Math.floor(p.percentInt / 25);
      if (bucket !== lastBucket) { lastBucket = bucket; announce(p.phaseLabel + ' ' + p.percentInt + '%'); }
    });
  }

  // ====================================================================
  // Rendering: stat cards (mode-aware)
  // ====================================================================

  function codonColorIndex(codon) {
    var stops = activeStops();
    var i = stops.indexOf(codon);
    return i >= 0 ? (i % 6) + 1 : 6;
  }
  // Results-table codon pills render the codon as colored TEXT on the light card
  // background, so they use the darker --codon-N-ink ramp (>=4.5:1 WCAG AA on
  // white) rather than the saturated --codon-N chart-fill ramp. In dark mode
  // --codon-N-ink resolves back to the bright --codon-N hue (see styles.css).
  function codonColorVar(codon) { return 'var(--codon-' + codonColorIndex(codon) + '-ink)'; }

  var SOURCE_WORDS = {
    user: 'manual selection', organism: 'your indicated organism',
    declared: 'the file’s transl_table', header: 'header keywords', 'default': 'the default'
  };

  function renderSummaryProvenance() {
    var el = $('summary-provenance');
    if (!el) return;
    var parts = ['Translation table: ' + tableLabel(state.activeTableId) +
      ' — from ' + (SOURCE_WORDS[state.tableSource] || state.tableSource) + '.'];
    if (state.userOrganism) parts.push('Organism: ' + state.userOrganism + '.');
    el.textContent = parts.join(' ');
    el.hidden = false;
  }

  // Genetic-code sanity nudge: prominent, actionable banner with a one-click
  // jump to the translation-table control. Announced via role="alert".
  function updateSanityNudge() {
    var el = $('sanity-nudge');
    if (!el) return;
    var sanity = state.codeSanity;
    if (!sanity || !sanity.suspicious || !sanity.message) { el.hidden = true; return; }
    // The heuristic message already ends with a "check the table" prompt; strip
    // that tail since the banner heading + button already say it.
    var txt = sanity.message.replace(/^The selected genetic code may be wrong for this data:\s*/i, '')
      .replace(/\.\s*Check the translation table \/ organism\.?\s*$/i, '.');
    $('sanity-nudge-text').textContent = txt +
      ' If your organism uses a non-standard code, switching tables may resolve these.';
    el.hidden = false;
    announce('Warning: the selected genetic code may be wrong for this data.');
  }

  // Inline reframing of in-frame internal CDS stops as recoding/readthrough
  // candidates rather than plain "premature stops".
  function updateReadthroughNote() {
    var note = $('readthrough-note');
    if (!note) return;
    var n = (state.summary && state.summary.byContext &&
      state.summary.byContext['cds-internal-inframe']) || 0;
    if (!state.annotationActive || n <= 0) { note.hidden = true; return; }
    var c = $('readthrough-count');
    if (c) c.textContent = fmtInt(n);
    note.hidden = false;
  }

  function renderStatCards() {
    renderSummaryProvenance();
    var s = state.summary;
    var grid = $('stat-grid');
    grid.innerHTML = '';
    var ss = seqStats();

    var cards = [];
    cards.push({ label: 'Sequences', value: fmtInt(ss.count) });
    cards.push({ label: 'Total length', value: fmtInt(s.totalLength) + ' bp' });
    cards.push({ label: 'GC content', value: s.gcPercent.toFixed(1) + '%' });
    cards.push({
      label: state.mode === 'coding' ? 'Gene-terminating stops' : 'Total stop codons',
      value: fmtInt(s.totalStops), hero: true
    });

    // Per-codon cards, ordered by the active table's stop list.
    activeStops().forEach(function (codon, idx) {
      var name = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[codon]) || 'stop';
      cards.push({
        label: codon + (name !== 'stop' ? ' (' + name + ')' : ''),
        value: fmtInt(s.byCodon[codon] || 0),
        accent: (idx % 6) + 1
      });
    });

    cards.push({ label: 'Forward strand (+)', value: fmtInt(s.byStrand['+']), strand: 'plus' });
    cards.push({ label: 'Reverse strand (−)', value: fmtInt(s.byStrand['-']), strand: 'minus' });
    cards.push({ label: 'Density', value: s.densityPerKb.toFixed(2) + ' /kb', sub: 'stops per 1,000 bp' });

    if (state.annotationActive) {
      var term = (s.byContext['cds-terminator'] || 0) + (s.byContext['orf-terminator'] || 0);
      cards.push({ label: 'CDS / ORF terminators', value: fmtInt(term) });
    }

    var frag = document.createDocumentFragment();
    cards.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'stat-card' + (c.hero ? ' hero' : '') +
        (c.accent ? ' accent-' + c.accent : '') +
        (c.strand ? ' strand-' + c.strand : '');
      var label = document.createElement('div'); label.className = 'stat-label'; label.textContent = c.label;
      var value = document.createElement('div'); value.className = 'stat-value'; value.textContent = c.value;
      div.appendChild(label); div.appendChild(value);
      if (c.sub) { var sub = document.createElement('div'); sub.className = 'stat-sub'; sub.textContent = c.sub; div.appendChild(sub); }
      frag.appendChild(div);
    });
    grid.appendChild(frag);
  }

  // ====================================================================
  // Rendering: per-frame breakdown (dynamic stop set)
  // ====================================================================

  var FRAME_ORDER = ['+1', '+2', '+3', '-1', '-2', '-3'];

  function tallyFrameCodon(hits, stops) {
    var table = {};
    FRAME_ORDER.forEach(function (k) {
      table[k] = { total: 0 };
      stops.forEach(function (c) { table[k][c] = 0; });
    });
    hits.forEach(function (h) {
      var key = h.strand + h.frame;
      if (table[key] && table[key][h.codon] !== undefined) { table[key][h.codon]++; table[key].total++; }
      else if (table[key]) { table[key].total++; } // codon not in active set (shouldn't happen)
    });
    return table;
  }

  function buildFrameChartSVG(table, stops) {
    var maxTotal = 1;
    FRAME_ORDER.forEach(function (k) { if (table[k].total > maxTotal) maxTotal = table[k].total; });

    var chartH = 170, barW = 42, gap = 26, marginLeft = 14, marginBottom = 32, marginTop = 22;
    var svgW = marginLeft + FRAME_ORDER.length * (barW + gap);
    var svgH = marginTop + chartH + marginBottom;
    var scale = chartH / maxTotal;

    var parts = [];
    parts.push('<line x1="' + marginLeft + '" y1="' + (marginTop + chartH) + '" x2="' + (svgW - gap / 2) +
      '" y2="' + (marginTop + chartH) + '" style="stroke:var(--border-strong);stroke-width:1"/>');

    FRAME_ORDER.forEach(function (key, idx) {
      var d = table[key];
      var x = marginLeft + idx * (barW + gap) + gap / 2;
      var yCursor = marginTop + chartH;
      stops.forEach(function (codon, ci) {
        var v = d[codon] || 0;
        var h = v * scale;
        if (h > 0.001) {
          yCursor -= h;
          parts.push('<rect x="' + x.toFixed(1) + '" y="' + yCursor.toFixed(1) + '" width="' + barW +
            '" height="' + h.toFixed(1) + '" style="fill:var(--codon-' + ((ci % 6) + 1) + ')"><title>' + key + ' ' +
            codon + ': ' + v + '</title></rect>');
        }
      });
      if (d.total === 0) {
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + (marginTop + chartH - 2) + '" width="' + barW +
          '" height="2" style="fill:var(--border)"/>');
      }
      var topY = marginTop + chartH - d.total * scale;
      parts.push('<text x="' + (x + barW / 2).toFixed(1) + '" y="' + Math.max(topY - 6, marginTop + 10).toFixed(1) +
        '" text-anchor="middle" font-size="11" style="fill:var(--text-muted)">' + d.total + '</text>');
      parts.push('<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (marginTop + chartH + 20) +
        '" text-anchor="middle" font-size="12" font-weight="600" style="fill:var(--text)">' + key + '</text>');
    });

    return '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" width="' + svgW + '" height="' + svgH +
      '" xmlns="http://www.w3.org/2000/svg" role="presentation">' + parts.join('') + '</svg>';
  }

  // Simple "Stop codon totals" chart: one horizontal bar per stop-codon TYPE
  // with its total count across the genome. No frame/strand breakdown.
  function renderStopTotals() {
    var el = $('totals-chart');
    if (!el || !state.summary) return;
    // Keep the card intro honest about WHAT is being counted in the active mode:
    // gene-terminating stops (one per CDS/ORF) vs every six-frame chance triplet.
    var intro = $('totals-intro');
    if (intro) {
      intro.textContent = state.mode === 'coding'
        ? 'How many of each stop codon actually terminate a gene — the one real terminating stop per CDS' +
          (state.annotationActive && !state.hasCDS ? '/predicted ORF' : '') + ', not the six-frame chance triplets.'
        : 'How many of each stop codon are present, counted across the whole genome (all six reading frames).';
    }
    var stops = activeStops();
    var by = state.summary.byCodon || {};
    var counts = stops.map(function (c) { return by[c] || 0; });
    var max = Math.max.apply(null, counts.concat([1]));
    var rowH = 42, padTop = 8, padBottom = 6, labelW = 150, barX = 158, barMaxW = 380, barH = 22;
    var W = 640, H = padTop + stops.length * rowH + padBottom;
    var body = stops.map(function (codon, i) {
      var count = by[codon] || 0;
      var name = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[codon]) || 'stop';
      var label = codon + (name !== 'stop' ? ' (' + name + ')' : '');
      var cy = padTop + i * rowH + rowH / 2;
      var bw = Math.max(2, Math.round((count / max) * barMaxW));
      var color = 'var(--codon-' + ((i % 6) + 1) + ')';
      return '<text x="' + (labelW - 10) + '" y="' + cy + '" text-anchor="end" dominant-baseline="central" font-size="14" font-weight="600" fill="var(--text)">' + label + '</text>' +
        '<rect x="' + barX + '" y="' + (cy - barH / 2) + '" width="' + bw + '" height="' + barH + '" rx="4" fill="' + color + '"></rect>' +
        '<text x="' + (barX + bw + 8) + '" y="' + cy + '" text-anchor="start" dominant-baseline="central" font-size="13" font-weight="700" fill="var(--text)">' + fmtInt(count) + '</text>';
    }).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="inherit">' + body + '</svg>';
  }

  function renderFrameBreakdown() {
    renderStopTotals();
    var stops = activeStops();
    var table = tallyFrameCodon(state.displayHits, stops);
    $('frame-chart-container').innerHTML = buildFrameChartSVG(table, stops);

    // Head
    var head = $('frame-thead-row'); head.innerHTML = '';
    var frag = document.createDocumentFragment();
    ['Frame'].concat(stops).concat(['Total']).forEach(function (label) {
      var th = document.createElement('th'); th.textContent = label; frag.appendChild(th);
    });
    head.appendChild(frag);

    // Body
    var body = $('frame-table-body'); body.innerHTML = '';
    var bfrag = document.createDocumentFragment();
    FRAME_ORDER.forEach(function (key) {
      var d = table[key];
      var tr = document.createElement('tr');
      var cells = [key].concat(stops.map(function (c) { return d[c] || 0; })).concat([d.total]);
      cells.forEach(function (val) { var td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
      bfrag.appendChild(tr);
    });
    body.appendChild(bfrag);

    // Legend
    var legend = $('frame-legend'); legend.innerHTML = '';
    stops.forEach(function (codon, ci) {
      var name = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[codon]) || 'stop';
      var span = document.createElement('span');
      span.innerHTML = '<span class="legend-swatch" style="background:var(--codon-' + ((ci % 6) + 1) + ')"></span>' +
        codon + (name !== 'stop' ? ' (' + name + ')' : '');
      legend.appendChild(span);
    });
  }

  // ====================================================================
  // Rendering: per-gene summary
  // ====================================================================

  var GENE_COLUMNS = [
    { key: 'gene', label: 'Gene' },
    { key: 'locusTag', label: 'Locus tag' },
    { key: 'product', label: 'Product' },
    { key: 'length', label: 'Length (bp)' },
    { key: 'internalStops', label: 'Internal stops' },
    { key: 'terminatorCodon', label: 'Terminator' }
  ];

  function renderGeneSummary() {
    var card = $('genesummary-card');
    if (!state.geneSummary || !state.geneSummary.length) { card.hidden = true; return; }
    card.hidden = false;

    // Head
    var head = $('genesummary-thead-row'); head.innerHTML = '';
    var hfrag = document.createDocumentFragment();
    GENE_COLUMNS.forEach(function (col) {
      var th = document.createElement('th'); th.className = 'sortable-th';
      if (state.geneSort.key === col.key) th.setAttribute('aria-sort', state.geneSort.dir === 'asc' ? 'ascending' : 'descending');
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = col.label;
      btn.setAttribute('aria-label', 'Sort by ' + col.label);
      btn.addEventListener('click', function () { onGeneSort(col.key); });
      th.appendChild(btn); hfrag.appendChild(th);
    });
    head.appendChild(hfrag);

    // Sort
    var rows = state.geneSummary.slice();
    var key = state.geneSort.key, dir = state.geneSort.dir === 'desc' ? -1 : 1;
    rows.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      av = String(av == null ? '' : av); bv = String(bv == null ? '' : bv);
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });

    var maxLen = 1;
    rows.forEach(function (r) { if (r.length > maxLen) maxLen = r.length; });

    var body = $('genesummary-body'); body.innerHTML = '';
    var frag = document.createDocumentFragment();
    var flagged = 0;
    rows.forEach(function (r) {
      var tr = document.createElement('tr');

      var geneTd = document.createElement('td');
      if (r.pseudogeneFlag) { flagged++; geneTd.innerHTML = '<span class="dot dot-warn" title="Has in-frame internal stop(s)"></span> '; }
      var gspan = document.createElement('span');
      gspan.className = 'gene-chip' + (r.gene ? '' : ' empty');
      gspan.textContent = r.gene || r.locusTag || r.featureId || '—';
      geneTd.appendChild(gspan);
      tr.appendChild(geneTd);

      appendCell(tr, r.locusTag || '—');
      var prodTd = document.createElement('td');
      prodTd.textContent = r.product ? truncate(r.product, 48) : '—';
      if (r.product) prodTd.title = r.product;
      tr.appendChild(prodTd);

      appendCell(tr, fmtInt(r.length));

      var intTd = document.createElement('td');
      var meterWrap = document.createElement('span');
      meterWrap.className = 'mini-meter' + (r.internalStops > 0 ? ' has-internal' : '');
      var bar = document.createElement('span');
      bar.style.width = Math.max(4, Math.round((r.length / maxLen) * 100)) + '%';
      meterWrap.appendChild(bar);
      intTd.appendChild(document.createTextNode(r.internalStops + ' '));
      intTd.appendChild(meterWrap);
      tr.appendChild(intTd);

      appendCell(tr, r.terminatorCodon || '—');
      frag.appendChild(tr);
    });
    body.appendChild(frag);

    $('genesummary-note').textContent = fmtInt(rows.length) + ' CDS' + (rows.length === 1 ? '' : 's') +
      (flagged ? ' — ' + fmtInt(flagged) + ' with in-frame internal stop(s) (possible pseudogene' + (flagged === 1 ? '' : 's') + ')' : '') + '.';
  }

  function onGeneSort(key) {
    if (state.geneSort.key === key) state.geneSort.dir = state.geneSort.dir === 'asc' ? 'desc' : 'asc';
    else { state.geneSort.key = key; state.geneSort.dir = 'asc'; }
    renderGeneSummary();
  }

  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // ====================================================================
  // Rendering: results table
  // ====================================================================

  var BASE_COLUMNS = [
    { key: 'seqId', label: 'Seq ID' },
    { key: 'start', label: 'Start' },
    { key: 'end', label: 'End' },
    { key: 'strand', label: 'Strand' },
    { key: 'frame', label: 'Frame' },
    { key: 'codon', label: 'Codon' }
  ];

  function setupResultColumns() {
    var cols = BASE_COLUMNS.slice();
    if (state.annotationActive) {
      cols.push({ key: 'gene', label: 'Gene' });
      cols.push({ key: 'context', label: 'Context' });
    }
    cols.push({ key: 'name', label: 'Name' });
    state.columns = cols;

    var row = $('results-thead-row'); row.innerHTML = '';
    var frag = document.createDocumentFragment();
    cols.forEach(function (col) {
      var th = document.createElement('th'); th.className = 'sortable-th';
      if (state.sort.key === col.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = col.label;
      btn.setAttribute('aria-label', 'Sort by ' + col.label);
      btn.addEventListener('click', function () { onSortClick(col.key); });
      th.appendChild(btn); frag.appendChild(th);
    });
    row.appendChild(frag);
  }

  function onSortClick(key) {
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort.key = key; state.sort.dir = 'asc'; }
    setupResultColumns();
    renderResultsTable();
  }

  function populateCodonFilter() {
    var sel = $('filter-codon');
    var cur = sel.value;
    sel.innerHTML = '<option value="all">All codons</option>';
    activeStops().forEach(function (codon) {
      var name = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[codon]) || 'stop';
      var o = document.createElement('option');
      o.value = codon;
      o.textContent = codon + (name !== 'stop' ? ' (' + name + ')' : '');
      sel.appendChild(o);
    });
    // keep prior selection if still valid
    var ok = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === cur) ok = true;
    sel.value = ok ? cur : 'all';
  }

  function updateFilterVisibility() {
    $('filter-gene-field').hidden = !state.annotationActive;
    $('filter-context-field').hidden = !state.annotationActive;
  }

  function hitGeneName(h) {
    if (h.geneName) return h.geneName;
    if (h.locusTag) return h.locusTag;
    if (h.product) return truncate(h.product, 40);
    if (h.featureId) return h.featureId;
    return null;
  }

  function getFilteredSortedDisplayHits() {
    var seqidFilter = $('filter-seqid').value.trim().toLowerCase();
    var geneFilter = state.annotationActive ? $('filter-gene').value.trim().toLowerCase() : '';
    var codonFilter = $('filter-codon').value;
    var strandFilter = $('filter-strand').value;
    var ctxFilter = state.annotationActive ? $('filter-context').value : 'all';

    var filtered = state.displayHits.filter(function (h) {
      if (codonFilter !== 'all' && h.codon !== codonFilter) return false;
      if (strandFilter !== 'all' && h.strand !== strandFilter) return false;
      if (seqidFilter && String(h.seqId).toLowerCase().indexOf(seqidFilter) === -1) return false;
      if (ctxFilter !== 'all' && h.context !== ctxFilter) return false;
      if (geneFilter) {
        var gn = (hitGeneName(h) || '').toLowerCase();
        if (gn.indexOf(geneFilter) === -1) return false;
      }
      return true;
    });

    var key = state.sort.key, dir = state.sort.dir === 'desc' ? -1 : 1;
    filtered.sort(function (a, b) {
      var av = sortValue(a, key), bv = sortValue(b, key);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      av = String(av == null ? '' : av); bv = String(bv == null ? '' : bv);
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });
    return filtered;
  }

  function sortValue(h, key) {
    if (key === 'gene') return (hitGeneName(h) || '').toLowerCase();
    if (key === 'context') return h.context || '';
    return h[key];
  }

  function appendCell(tr, value) { var td = document.createElement('td'); td.textContent = value; tr.appendChild(td); }

  function buildResultRow(h) {
    var tr = document.createElement('tr');
    if (h.id != null) tr.setAttribute('data-hid', h.id); // cross-view linking with the charts
    state.columns.forEach(function (col) {
      var td;
      switch (col.key) {
        case 'seqId': appendCell(tr, h.seqId); break;
        case 'start': appendCell(tr, h.start); break;
        case 'end': appendCell(tr, h.end); break;
        case 'strand':
          td = document.createElement('td');
          var sp = document.createElement('span');
          sp.className = 'strand-pill ' + (h.strand === '+' ? 'plus' : 'minus');
          sp.textContent = h.strand === '+' ? '+' : '−';
          td.appendChild(sp); tr.appendChild(td); break;
        case 'frame': appendCell(tr, (h.strand === '+' ? '+' : '−') + h.frame); break;
        case 'codon':
          td = document.createElement('td');
          var pill = document.createElement('span');
          pill.className = 'codon-pill';
          pill.style.color = codonColorVar(h.codon);
          pill.style.borderColor = 'currentColor';
          pill.textContent = h.codon;
          td.appendChild(pill); tr.appendChild(td); break;
        case 'gene':
          td = document.createElement('td');
          var gn = hitGeneName(h);
          var chip = document.createElement('span');
          chip.className = 'gene-chip' + (gn ? '' : ' empty');
          chip.textContent = gn || '—';
          if (h.product) chip.title = h.product;
          td.appendChild(chip); tr.appendChild(td); break;
        case 'context':
          td = document.createElement('td');
          if (h.context && CONTEXT_META[h.context]) {
            var badge = document.createElement('span');
            badge.className = 'ctx-badge ' + CONTEXT_META[h.context].cls;
            badge.textContent = CONTEXT_META[h.context].label;
            td.appendChild(badge);
          } else { td.textContent = '—'; }
          tr.appendChild(td); break;
        case 'name': appendCell(tr, h.name); break;
        default: appendCell(tr, h[col.key]);
      }
    });
    return tr;
  }

  function renderResultsTableChunked(rows, myId, done) {
    var tbody = $('results-tbody');
    tbody.innerHTML = '';
    var i = 0, total = rows.length;
    function chunk() {
      if (myId !== state.runId) return;
      var end = Math.min(i + RENDER_CHUNK, total);
      var frag = document.createDocumentFragment();
      for (; i < end; i++) frag.appendChild(buildResultRow(rows[i]));
      tbody.appendChild(frag);
      global.ScanProgress.report('render', i);
      if (i >= total) { done(); return; }
      global.ScanProgress.yield(chunk);
    }
    if (total === 0) { done(); return; }
    chunk();
  }

  // Colour key for the results table: one entry per stop codon in the ACTIVE
  // genetic code, using the same pill colours as the table's Codon column, so
  // you can read a codon's type straight off its colour without the Name column.
  function renderCodonLegend() {
    var el = $('codon-legend');
    if (!el) return;
    el.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'codon-legend-label';
    label.textContent = 'Colour key:';
    el.appendChild(label);
    activeStops().forEach(function (codon) {
      var name = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[codon]) || 'stop';
      var item = document.createElement('span');
      item.className = 'codon-legend-item';
      item.setAttribute('role', 'listitem');
      var pill = document.createElement('span');
      pill.className = 'codon-pill';
      pill.style.color = codonColorVar(codon);
      pill.style.borderColor = 'currentColor';
      pill.textContent = codon;
      item.appendChild(pill);
      var nm = document.createElement('span');
      nm.className = 'codon-legend-name';
      nm.textContent = name;
      item.appendChild(nm);
      el.appendChild(item);
    });
  }

  function renderResultsTable() {
    if (!state.summary) return;
    renderCodonLegend();
    var rows = getFilteredSortedDisplayHits().slice(0, MAX_TABLE_ROWS);
    var tbody = $('results-tbody');
    tbody.innerHTML = '';
    var frag = document.createDocumentFragment();
    rows.forEach(function (h) { frag.appendChild(buildResultRow(h)); });
    tbody.appendChild(frag);
    updateTableNote();
  }

  function updateTableNote() {
    var note = $('table-note');
    var filtered = getFilteredSortedDisplayHits();
    var totalDisplay = state.displayHits.length;
    if (filtered.length === 0) {
      note.textContent = totalDisplay === 0
        ? (state.mode === 'coding'
            ? 'No coding / predicted stop codons for this configuration. Switch to "All stop codons" to see every hit.'
            : 'No stop codons were found in this input.')
        : 'No rows match the current filters (' + fmtInt(totalDisplay) + ' shown before filtering).';
    } else if (filtered.length > MAX_TABLE_ROWS) {
      note.textContent = 'Showing ' + fmtInt(MAX_TABLE_ROWS) + ' of ' + fmtInt(filtered.length) +
        ' matching hits — download the full report for all rows.';
    } else if (filtered.length !== totalDisplay) {
      note.textContent = 'Showing ' + fmtInt(filtered.length) + ' of ' + fmtInt(totalDisplay) + ' hit' + (totalDisplay === 1 ? '' : 's') + '.';
    } else {
      note.textContent = 'Showing all ' + fmtInt(filtered.length) + ' hit' + (filtered.length === 1 ? '' : 's') +
        (state.hits.length !== totalDisplay ? ' (' + fmtInt(state.hits.length) + ' total across all contexts).' : '.');
    }
  }

  // ====================================================================
  // Downloads (always the full hit set)
  // ====================================================================

  function baseFilename() {
    var seqFile = null;
    state.files.forEach(function (f) { if (!seqFile && fileRole(f.kind) === 'sequence') seqFile = f; });
    var name = (seqFile && seqFile.name) || (state.files[0] && state.files[0].name) || 'stop_codon_report';
    name = name.replace(/\.[^./\\]+$/, '').replace(/[^a-z0-9_\-]+/gi, '_');
    return name || 'stop_codon_report';
  }

  function onDownloadCsv() {
    if (!state.summary) return;
    var includeAnnotation = state.annotationActive;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.csv',
      global.CodonReport.toCSV(state.hits, { includeAnnotation: includeAnnotation }),
      'text/csv;charset=utf-8'
    );
  }

  function provenanceMeta() {
    return {
      organism: state.userOrganism || null,
      translationTable: {
        id: state.activeTableId,
        name: global.CodonTables.get(state.activeTableId).name,
        source: state.tableSource // user|organism|declared|header|default
      },
      declaredTranslTable: state.declaredTableId,
      detectedFromHeaders: state.headerTableId
    };
  }

  function onDownloadJson() {
    if (!state.summary) return;
    var fullSummary = global.CodonReport.buildSummary(state.hits, state.records, { stopCodons: activeStopSet() });
    // Carry the organism the user indicated + chosen table as export provenance.
    fullSummary.provenance = provenanceMeta();
    // Fold the per-gene summary + per-frame breakdown into the same document so
    // one JSON download carries every table shown in the UI.
    var extras = { stops: activeStops() };
    if (state.geneSummary && state.geneSummary.length) extras.geneSummary = state.geneSummary;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.json',
      global.CodonReport.toJSON(fullSummary, state.hits, extras),
      'application/json;charset=utf-8'
    );
  }

  function onDownloadTsv() {
    if (!state.summary) return;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.tsv',
      global.CodonReport.toTSV(state.hits, { includeAnnotation: state.annotationActive }),
      'text/tab-separated-values;charset=utf-8'
    );
  }

  function onDownloadMarkdown() {
    if (!state.summary) return;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.md',
      global.CodonReport.toMarkdown(state.hits, { includeAnnotation: state.annotationActive }),
      'text/markdown;charset=utf-8'
    );
  }

  // Copy text to the clipboard with a file:// -safe fallback (the async
  // Clipboard API is often blocked under file://, so fall back to a hidden
  // textarea + execCommand). Reports success/failure via the existing banners.
  function copyToClipboard(text, label) {
    function done() { showSuccess(label + ' copied to the clipboard.'); announce(label + ' copied.'); }
    function fail() { showInfo('Could not access the clipboard. Use a download button instead.'); }
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) ? done() : fail(); });
    } else {
      legacyCopy(text) ? done() : fail();
    }
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function onCopyTsv() {
    if (!state.summary) { showInfo('Run a scan first, then copy the table.'); return; }
    copyToClipboard(global.CodonReport.toTSV(state.hits, { includeAnnotation: state.annotationActive }),
      'Results table (TSV)');
  }
  function onCopyMarkdown() {
    if (!state.summary) { showInfo('Run a scan first, then copy the table.'); return; }
    copyToClipboard(global.CodonReport.toMarkdown(state.hits, { includeAnnotation: state.annotationActive }),
      'Results table (Markdown)');
  }

  // Concrete light-theme, AA-on-white codon ramps for the standalone HTML report
  // (which is deliberately a light, print-friendly sheet regardless of the app's
  // current theme). Falls back to the Okabe–Ito defaults if palettes are absent.
  function reportColors() {
    if (global.CodonPalettes) {
      var sc = global.CodonPalettes.get(state.colorScheme);
      if (sc) return { codonFills: sc.fillLight.slice(), codonInks: sc.inkLight.slice() };
    }
    return null;
  }

  function onDownloadHtmlReport() {
    if (!state.summary || !global.CodonReport.toHTMLReport) return;
    var stops = activeStops();
    var fullSummary = global.CodonReport.buildSummary(state.hits, state.records, { stopCodons: activeStopSet() });
    fullSummary.provenance = provenanceMeta();
    // Static copy of the key chart (per-frame breakdown) over the FULL hit set.
    var chartSVG = buildFrameChartSVG(tallyFrameCodon(state.hits, stops), stops);
    var stopNames = {};
    stops.forEach(function (c) {
      stopNames[c] = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[c]) || 'stop';
    });
    var html = global.CodonReport.toHTMLReport({
      title: 'Stop Codon Finder report — ' + baseFilename(),
      generatedAt: new Date().toISOString(),
      summary: fullSummary,
      provenance: {
        organism: state.userOrganism || null,
        translationTable: { id: state.activeTableId, name: global.CodonTables.get(state.activeTableId).name }
      },
      hits: state.hits,
      geneSummary: state.geneSummary,
      stops: stops,
      stopNames: stopNames,
      includeAnnotation: state.annotationActive,
      chartSVG: chartSVG,
      colors: reportColors(),
      maxRows: MAX_TABLE_ROWS
    });
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.report.html',
      html,
      'text/html;charset=utf-8'
    );
  }

  // Shared payload for the workbook + text report: the FULL hit set, the full
  // summary (never the on-screen filtered slice), provenance, and stop metadata.
  function reportPayload() {
    var stops = activeStops();
    var fullSummary = global.CodonReport.buildSummary(state.hits, state.records, { stopCodons: activeStopSet() });
    fullSummary.provenance = provenanceMeta();
    var stopNames = {};
    stops.forEach(function (c) {
      stopNames[c] = (global.CodonTables.STOP_NAME && global.CodonTables.STOP_NAME[c]) || 'stop';
    });
    return {
      generatedAt: new Date().toISOString(),
      summary: fullSummary,
      provenance: provenanceMeta(),
      hits: state.hits,
      geneSummary: state.geneSummary || [],
      stops: stops,
      stopNames: stopNames,
      includeAnnotation: state.annotationActive
    };
  }

  function onDownloadXlsx() {
    if (!state.summary) return;
    if (!global.CodonXlsx || !global.CodonReport.toXlsx) {
      showInfo('Excel export is unavailable in this build.'); return;
    }
    var bytes = global.CodonReport.toXlsx(reportPayload());
    if (!bytes) { showInfo('Excel export is unavailable in this build.'); return; }
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.xlsx',
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  }

  function onDownloadText() {
    if (!state.summary || !global.CodonReport.toTextReport) return;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.txt',
      global.CodonReport.toTextReport(reportPayload()),
      'text/plain;charset=utf-8'
    );
  }

  // ---- Per-gene summary + per-frame breakdown table downloads ----------
  function onDownloadGeneSummary(fmt) {
    if (!state.geneSummary || !state.geneSummary.length) { showInfo('No per-gene summary to download (load an annotation with CDS features).'); return; }
    var isTsv = fmt === 'tsv';
    global.CodonReport.triggerDownload(
      baseFilename() + '.gene_summary.' + (isTsv ? 'tsv' : 'csv'),
      isTsv ? global.CodonReport.geneSummaryToTSV(state.geneSummary)
            : global.CodonReport.geneSummaryToCSV(state.geneSummary),
      (isTsv ? 'text/tab-separated-values' : 'text/csv') + ';charset=utf-8'
    );
  }
  function onDownloadFrameBreakdown(fmt) {
    if (!state.summary) return;
    var isTsv = fmt === 'tsv';
    var stops = activeStops();
    global.CodonReport.triggerDownload(
      baseFilename() + '.frame_breakdown.' + (isTsv ? 'tsv' : 'csv'),
      isTsv ? global.CodonReport.frameBreakdownToTSV(state.hits, stops)
            : global.CodonReport.frameBreakdownToCSV(state.hits, stops),
      (isTsv ? 'text/tab-separated-values' : 'text/csv') + ';charset=utf-8'
    );
  }

  // Features eligible for FASTA/protein export: real CDS plus any predicted ORFs
  // that were actually used in the last run.
  function exportableFeatures() {
    return (state.runFeatures || []).filter(function (f) {
      return f && (f.type === 'CDS' || f.type === 'ORF');
    });
  }

  function updateExportButtons() {
    var feats = exportableFeatures();
    var show = feats.length > 0;
    var fna = $('download-fna-btn'), faa = $('download-faa-btn');
    if (fna) fna.hidden = !show;
    if (faa) faa.hidden = !show;
  }

  function onDownloadGff3() {
    if (!state.summary || !global.CodonExport) return;
    global.CodonReport.triggerDownload(
      baseFilename() + '.stop_codons.gff3',
      global.CodonExport.toGFF3(state.hits, state.records, {}),
      'text/plain;charset=utf-8'
    );
  }

  function onDownloadBed() {
    if (!state.summary || !global.CodonExport) return;
    var bed9 = $('bed9-toggle') && $('bed9-toggle').checked;
    global.CodonReport.triggerDownload(
      baseFilename() + (bed9 ? '.stop_codons.bed9.bed' : '.stop_codons.bed'),
      global.CodonExport.toBED(state.hits, {
        bed9: bed9, stops: activeStops(),
        palette: (global.CodonPalettes && global.CodonPalettes.bedPalette(state.colorScheme)) || null
      }),
      'text/plain;charset=utf-8'
    );
  }

  function onDownloadFna() {
    if (!global.CodonExport) return;
    var feats = exportableFeatures();
    if (!feats.length) { showInfo('No ORFs or CDS to export. Switch to "Coding / predicted" mode or load an annotation.'); return; }
    global.CodonReport.triggerDownload(
      baseFilename() + '.orfs.fna',
      global.CodonExport.toFastaNucleotide(feats, state.records, {}),
      'text/plain;charset=utf-8'
    );
  }

  function onDownloadFaa() {
    if (!global.CodonExport) return;
    var feats = exportableFeatures();
    if (!feats.length) { showInfo('No ORFs or CDS to translate. Switch to "Coding / predicted" mode or load an annotation.'); return; }
    global.CodonReport.triggerDownload(
      baseFilename() + '.proteins.faa',
      global.CodonExport.toFastaProtein(feats, state.records, { tableId: state.activeTableId }),
      'text/plain;charset=utf-8'
    );
  }

  // ====================================================================
  // Visualizations (genome map card) + table linking
  // ====================================================================

  function currentVizRecord() {
    if (!state.records.length) return null;
    var id = state.vizRecordId;
    for (var i = 0; i < state.records.length; i++) if (state.records[i].id === id) return state.records[i];
    return state.records[0];
  }

  // Click a stop tick in any chart -> reveal + flash its results-table row.
  function selectHit(hitId) {
    if (hitId == null) return;
    var esc = (global.CSS && global.CSS.escape) ? global.CSS.escape(hitId) : hitId;
    var row = document.querySelector('#results-tbody tr[data-hid="' + esc + '"]');
    if (!row) {
      showInfo('That stop (' + hitId + ') is outside the current table view or filters.');
      return;
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('row-flash');
    global.setTimeout(function () { row.classList.remove('row-flash'); }, 1600);
  }

  function buildVizRecordSelect() {
    var field = $('viz-record-field'), sel = $('viz-record-select');
    if (!sel) return;
    if (state.records.length <= 1) { if (field) field.hidden = true; return; }
    if (field) field.hidden = false;
    sel.innerHTML = '';
    state.records.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.id + ' (' + fmtInt(r.seq.length) + ' bp)' + (r.circular ? ' · circular' : '');
      sel.appendChild(o);
    });
    sel.value = currentVizRecord().id;
  }

  function renderViz() {
    if (!global.CodonViz) return;
    var card = $('viz-card');
    var rec = currentVizRecord();
    if (!rec || !state.summary) { if (card) card.hidden = true; return; }
    if (card) card.hidden = false;
    state.vizRecordId = rec.id;

    var common = {
      rec: rec, hits: state.displayHits, features: state.runFeatures,
      stops: activeStops(), onSelect: selectHit
    };
    state.vizSvgs.frame = global.CodonViz.renderFrameTrack($('viz-frame'), common);
    state.vizSvgs.density = global.CodonViz.renderDensity($('viz-density'), common);

    var circBlock = $('viz-circular-block');
    if (rec.circular) {
      if (circBlock) circBlock.hidden = false;
      state.vizSvgs.circular = global.CodonViz.renderCircular($('viz-circular'), common);
    } else {
      if (circBlock) circBlock.hidden = true;
      state.vizSvgs.circular = null;
    }
  }

  function onVizDownload(which, fmt) {
    if (!global.CodonExport) return;
    var svg = state.vizSvgs[which];
    if (!svg) { showInfo('That chart is not available for the current view.'); return; }
    var name = baseFilename() + '.' + which + '.' + (fmt === 'png' ? 'png' : 'svg');
    if (fmt === 'png') global.CodonExport.downloadPNG(svg, name);
    else global.CodonExport.downloadSVG(svg, name);
  }

  function setupExports() {
    var g = $('download-gff3-btn'); if (g) g.addEventListener('click', onDownloadGff3);
    var b = $('download-bed-btn'); if (b) b.addEventListener('click', onDownloadBed);
    var fna = $('download-fna-btn'); if (fna) fna.addEventListener('click', onDownloadFna);
    var faa = $('download-faa-btn'); if (faa) faa.addEventListener('click', onDownloadFaa);

    // New results-table formats + clipboard + printable HTML report.
    var tsv = $('download-tsv-btn'); if (tsv) tsv.addEventListener('click', onDownloadTsv);
    var md = $('download-md-btn'); if (md) md.addEventListener('click', onDownloadMarkdown);
    var html = $('download-html-btn'); if (html) html.addEventListener('click', onDownloadHtmlReport);
    var xlsx = $('download-xlsx-btn'); if (xlsx) xlsx.addEventListener('click', onDownloadXlsx);
    var txt = $('download-txt-btn'); if (txt) txt.addEventListener('click', onDownloadText);
    var cpT = $('copy-tsv-btn'); if (cpT) cpT.addEventListener('click', onCopyTsv);
    var cpM = $('copy-md-btn'); if (cpM) cpM.addEventListener('click', onCopyMarkdown);

    // Per-gene summary + per-frame breakdown card downloads (CSV + TSV each).
    var gc = $('gene-csv-btn'); if (gc) gc.addEventListener('click', function () { onDownloadGeneSummary('csv'); });
    var gt = $('gene-tsv-btn'); if (gt) gt.addEventListener('click', function () { onDownloadGeneSummary('tsv'); });
    var fc = $('frame-csv-btn'); if (fc) fc.addEventListener('click', function () { onDownloadFrameBreakdown('csv'); });
    var ft = $('frame-tsv-btn'); if (ft) ft.addEventListener('click', function () { onDownloadFrameBreakdown('tsv'); });

    var sel = $('viz-record-select');
    if (sel) sel.addEventListener('change', function () { state.vizRecordId = this.value; renderViz(); });

    // Figure (SVG/PNG) download buttons, delegated by data-viz / data-fmt.
    var dls = document.querySelectorAll('.viz-dl');
    for (var i = 0; i < dls.length; i++) {
      (function (wrap) {
        var which = wrap.getAttribute('data-viz');
        wrap.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-fmt]');
          if (btn) onVizDownload(which, btn.getAttribute('data-fmt'));
        });
      })(dls[i]);
    }

    // Results table row -> highlight the matching tick across the charts.
    var tbody = $('results-tbody');
    if (tbody && global.CodonViz) {
      tbody.addEventListener('mouseover', function (e) {
        var tr = e.target.closest ? e.target.closest('tr[data-hid]') : null;
        if (tr) global.CodonViz.highlight(tr.getAttribute('data-hid'), true);
      });
      tbody.addEventListener('mouseout', function (e) {
        var tr = e.target.closest ? e.target.closest('tr[data-hid]') : null;
        if (tr) global.CodonViz.highlight(tr.getAttribute('data-hid'), false);
      });
    }
  }

  // ====================================================================
  // Reset
  // ====================================================================

  function resetAll() {
    state.runId++;                 // kill any in-flight scan
    state.files = [];
    state.records = [];
    state.features = [];
    state.runFeatures = [];
    state.hits = [];
    state.displayHits = [];
    state.summary = null;
    state.geneSummary = [];
    state.annotationActive = false;
    state.hasAnnotation = false;
    state.hasCDS = false;
    state.scanning = false;
    state.sort = { key: 'start', dir: 'asc' };
    state.geneSort = { key: 'internalStops', dir: 'desc' };

    // Reset translation-table precedence inputs.
    state.tableUserSet = false;
    state.userOrganism = '';
    state.organismTableId = null;
    state.declaredTableId = null;
    state.headerTableId = null;
    state.activeTableId = DEFAULT_TABLE_ID;
    state.tableSource = 'default';
    state.codeNoteDismissed = false;
    if ($('organism-input')) $('organism-input').value = '';
    if ($('code-note')) $('code-note').hidden = true;

    state.vizRecordId = null;
    state.vizSvgs = {};
    if ($('viz-card')) $('viz-card').hidden = true;

    clearMessages();
    showProgressPanel(false);
    showResultsSection(false);
    $('settings-section').hidden = true;
    $('slots').hidden = true;
    $('load-footer').hidden = true;
    $('slot-a-body').innerHTML = '';
    $('slot-b-body').innerHTML = '';
    $('filter-seqid').value = '';
    if ($('filter-gene')) $('filter-gene').value = '';
    $('filter-codon').value = 'all';
    $('filter-strand').value = 'all';
    if ($('filter-context')) $('filter-context').value = 'all';
    $('file-input').value = '';
  }

  // ====================================================================
  // Wiring
  // ====================================================================

  function setupDropzone() {
    var dz = $('dropzone');
    var input = $('file-input');
    var chooseBtn = $('choose-file-btn');

    chooseBtn.addEventListener('click', function (e) { e.stopPropagation(); input.click(); });

    dz.addEventListener('click', function (e) {
      if (e.target.closest('#example-menu')) return;
      if (e.target === chooseBtn) return;
      input.click();
    });
    dz.addEventListener('keydown', function (e) {
      if (e.target !== dz) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dz.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) handleFileList(files);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length > 0) handleFileList(input.files);
      input.value = '';
    });
  }

  function setupExampleMenu() {
    var btn = $('load-example-btn');
    var list = $('example-list');
    var items = Array.prototype.slice.call(list.querySelectorAll('[role="menuitem"]'));
    // Elevate the containing card above later sections while the menu is open,
    // so the dropdown is never covered — a class toggle works in every browser
    // (the CSS :has() rule is a fallback for engines that support it).
    var card = btn.closest('section.card');
    function close(returnFocus) {
      if (list.hidden) return;
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (card) card.classList.remove('menu-open');
      if (returnFocus) btn.focus();
    }
    function open() { list.hidden = false; btn.setAttribute('aria-expanded', 'true'); if (card) card.classList.add('menu-open'); }
    function focusItem(i) {
      if (!items.length) return;
      var n = ((i % items.length) + items.length) % items.length;
      items[n].focus();
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (list.hidden) open(); else close(false);
    });
    // ARIA menu keyboard contract the roles advertise: open with Down/Up (moving
    // focus into the menu), roving arrow navigation among items, Home/End, and
    // Escape to close and return focus to the trigger.
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); focusItem(0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) open(); focusItem(items.length - 1); }
      else if (e.key === 'Escape') { close(false); }
    });
    list.addEventListener('keydown', function (e) {
      var idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
      else if (e.key === 'End') { e.preventDefault(); focusItem(items.length - 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') { close(false); }
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-example]');
      if (!b) return;
      e.stopPropagation();
      close(false);
      loadExample(b.getAttribute('data-example'));
    });
    document.addEventListener('click', function () { if (!list.hidden) close(false); });
  }

  function setupModeControl() {
    var group = $('mode-group');
    var btns = Array.prototype.slice.call(group.querySelectorAll('.seg'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); b.focus(); });
    });
    group.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var idx = btns.indexOf(document.activeElement);
      if (idx === -1) idx = 0;
      var next = e.key === 'ArrowRight' ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
      btns[next].focus();
      setMode(btns[next].getAttribute('data-mode'));
    });
  }

  function setupSettings() {
    setupModeControl();

    $('table-select').addEventListener('change', function () {
      state.activeTableId = Number(this.value);
      // Rule 1: an explicit manual pick wins and is never auto-overridden after.
      state.tableUserSet = true;
      state.tableSource = 'user';
      state.codeNoteDismissed = false;
      updateStopsCaption();
      updateSettingsSummary();
      buildCodeNote();
      debouncedRescan();
    });

    var orgInput = $('organism-input');
    if (orgInput) {
      orgInput.addEventListener('input', function () {
        state.userOrganism = this.value.trim();
        state.organismTableId = state.userOrganism
          ? global.CodonTables.organismToTable(state.userOrganism) : null;
        state.codeNoteDismissed = false;
        // Organism is precedence rule 2: it re-resolves the table unless the
        // user has already made an explicit manual pick (rule 1 wins).
        resolveTable();
        debouncedRescan();
      });
    }

    var noteDismiss = $('code-note-dismiss');
    if (noteDismiss) noteDismiss.addEventListener('click', dismissCodeNote);

    var slider = $('minorf-slider'), number = $('minorf-number');
    slider.addEventListener('input', function () {
      number.value = slider.value;
      state.minOrfCodons = Math.max(1, Number(slider.value) || 1);
      updateSettingsSummary();
      debouncedRescan();
    });
    number.addEventListener('input', function () {
      var v = Math.max(1, Number(number.value) || 1);
      state.minOrfCodons = v;
      slider.value = Math.min(150, v);
      updateSettingsSummary();
      debouncedRescan();
    });
    $('alt-starts-toggle').addEventListener('change', function () {
      state.altStarts = this.checked;
      debouncedRescan();
    });
    $('orf-mode-select').addEventListener('change', function () {
      state.requireStart = (this.value !== 'stop');
      updateOrfModeUI();
      updateSettingsSummary();
      debouncedRescan();
    });
    $('run-btn').addEventListener('click', function () { if (state.records.length) runScan(); });
  }

  function setupFilters() {
    $('filter-seqid').addEventListener('input', renderResultsTable);
    $('filter-codon').addEventListener('change', renderResultsTable);
    $('filter-strand').addEventListener('change', renderResultsTable);
    if ($('filter-gene')) $('filter-gene').addEventListener('input', renderResultsTable);
    if ($('filter-context')) $('filter-context').addEventListener('change', renderResultsTable);
  }

  // Any element carrying a data-tip (the inline "?" help icons and the .sci-note
  // lore footnotes) shows its explanation only via a CSS ::after tooltip, which
  // is invisible to assistive tech. Fold that text into each element's
  // accessible name so a screen reader announces the full explanation. For the
  // "?" icons an aria-label already exists in the HTML and is prepended; for
  // sci-note words there is none, so the visible word becomes the base. Done in
  // JS so the tip string lives in exactly one place (data-tip); if JS is off,
  // any aria-label authored in the HTML still applies.
  function exposeHelpTips() {
    var els = document.querySelectorAll('[data-tip]');
    for (var i = 0; i < els.length; i++) {
      var tip = els[i].getAttribute('data-tip');
      if (!tip) continue;
      var label = els[i].getAttribute('aria-label');
      if (!label) label = (els[i].textContent || '').trim();
      els[i].setAttribute('aria-label', label ? label + ': ' + tip : tip);
    }
  }

  function init() {
    initTheme();
    initColorScheme();
    exposeHelpTips();
    wireProgress();
    setupDropzone();
    setupExampleMenu();
    setupSettings();
    setupFilters();
    setupExports();

    $('theme-toggle').addEventListener('click', toggleTheme);
    $('reset-btn').addEventListener('click', resetAll);
    $('cancel-btn').addEventListener('click', cancelScan);
    $('download-csv-btn').addEventListener('click', onDownloadCsv);
    $('download-json-btn').addEventListener('click', onDownloadJson);

    // Sanity-nudge one-click jump: focus the genetic-code selector so the user
    // can immediately pick a different translation table.
    var nudgeFix = $('sanity-nudge-fix');
    if (nudgeFix) nudgeFix.addEventListener('click', function () {
      var sel = $('table-select');
      var settings = $('settings-section');
      if (settings && !settings.hidden && settings.scrollIntoView) {
        settings.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (sel && sel.focus) sel.focus();
    });

    // Stamp today's date into the suggested citation.
    var citeDate = $('cite-date');
    if (citeDate) {
      try { citeDate.textContent = new Date().toISOString().slice(0, 10); }
      catch (e) { citeDate.textContent = ''; }
    }

    initDecor();
  }

  // ====================================================================
  // Decorative polish layer (additive; reduced-motion + tab-visibility safe)
  // ====================================================================
  function initDecor() {
    // Tab-visibility pause: toggles the attribute the CSS kill-switch reads.
    function syncPaused() {
      document.documentElement.toggleAttribute('data-scf-paused', document.hidden);
    }
    document.addEventListener('visibilitychange', syncPaused);
    syncPaused();

    // Rotating footer fact (static first fact under reduced-motion; pauses when
    // the tab is hidden).
    (function () {
      var facts = [
        'UUU = phenylalanine was the first codon ever deciphered — Nirenberg & Matthaei, 1961.',
        'Only 3 of the 64 codons are stops: UAG, UAA, UGA.',
        '“Amber,” “ochre,” and “opal” are lab nicknames for the three stop codons.',
        'UGA can mean “stop” — or selenocysteine, the 21st amino acid.',
        'Nirenberg, Khorana, and Holley won the 1968 Nobel for cracking the code.',
        'Scientists have built bacteria that run on just 61 codons (Syn61, 2019).'
      ];
      var el = $('scf-fact');
      if (!el) return;
      el.textContent = facts[0];
      var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) return;
      var i = 0;
      setInterval(function () {
        if (document.hidden) return;
        el.style.opacity = '0';
        setTimeout(function () {
          i = (i + 1) % facts.length;
          el.textContent = facts[i];
          el.style.opacity = '1';
        }, 500);
      }, 7000);
    })();

    // Easter egg: a one-shot "base-pair pop" when the hero helix is clicked.
    var helix = $('scf-helix');
    if (helix) helix.addEventListener('click', function () {
      helix.classList.remove('scf-pop');
      void helix.offsetWidth;   // reflow so the animation restarts
      helix.classList.add('scf-pop');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(typeof window !== 'undefined' ? window : this, document);
