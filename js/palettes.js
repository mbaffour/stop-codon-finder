/*
 * palettes.js -- selectable codon colour-scheme registry (global CodonPalettes).
 *
 * Each scheme supplies FOUR 6-length hex ramps, indexed by a codon's position in
 * the active stop list (index 0 -> --codon-1, never by codon name, so a codon
 * never means two colours):
 *   fillLight / fillDark  = saturated chart FILL hues (bars, ticks, arcs, density)
 *   inkLight  / inkDark   = TEXT hues for the codon pills, each >=4.5:1 (WCAG AA)
 *                           on its card background (light card #fff / dark card
 *                           #161d22). Verified in-repo; see README of this task.
 *
 * apply(id, theme) stamps --codon-1..6 (fill) and --codon-1..6-ink (text) as
 * inline custom properties on <html> for the current theme. Because these are
 * inline they win over the stylesheet's theme blocks, so the caller MUST re-apply
 * on every theme change (app.js toggleTheme does). Everything on screen paints via
 * var(--codon-N) / var(--codon-N-ink), so updating the props live-repaints the
 * legend, table pills, per-frame chart, CodonViz and stat-card accents with no
 * DOM rebuild. 100% client-side, no deps -- file:// and Pages safe.
 */
(function (global) {
  'use strict';

  var SCHEMES = [
    {
      id: 'colourblind-safe',
      label: 'Colour-blind safe (Okabe–Ito)',
      note: 'Well-separated hues distinguishable for common colour-vision deficiencies.',
      // Okabe-Ito. Indices 1/2/3 (TAA/TAG/TGA) = orange / sky-blue / bluish-green:
      // three obviously different hues.
      fillLight: ['#e69f00', '#56b4e9', '#009e73', '#d55e00', '#0072b2', '#cc79a7'],
      inkLight:  ['#946200', '#1f6f9e', '#00785a', '#b34a00', '#0067a3', '#a24c7e'],
      fillDark:  ['#f0a830', '#6bc0f0', '#2fc79a', '#f0813c', '#4aa8e6', '#e39bc4'],
      inkDark:   ['#f0a830', '#6bc0f0', '#2fc79a', '#f0813c', '#4aa8e6', '#e39bc4']
    },
    {
      id: 'vivid',
      label: 'Vivid',
      note: 'Bright, saturated, high-chroma hues.',
      fillLight: ['#e11d48', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'],
      inkLight:  ['#c81440', '#9a5a00', '#047857', '#1d5fd6', '#7b3fd6', '#c22a6f'],
      fillDark:  ['#ff5c7a', '#f9b53d', '#34d399', '#5b9bff', '#a98bff', '#f472b6'],
      inkDark:   ['#ff5c7a', '#f9b53d', '#34d399', '#5b9bff', '#a98bff', '#f472b6']
    },
    {
      id: 'gemstone',
      label: 'Gemstone (classic)',
      note: 'The original ochre / amber / opal jewel palette.',
      fillLight: ['#b8860b', '#e08a00', '#0f9e8f', '#5b6cc4', '#b5468b', '#6c7a89'],
      inkLight:  ['#8a6300', '#9a5b00', '#0b6f64', '#4a58ab', '#9c3874', '#566470'],
      fillDark:  ['#d8a938', '#f0a844', '#35d0b6', '#8fa0e8', '#e07ac0', '#9aa7b4'],
      inkDark:   ['#d8a938', '#f0a844', '#35d0b6', '#8fa0e8', '#e07ac0', '#9aa7b4']
    },
    {
      id: 'high-contrast',
      label: 'High contrast',
      note: 'Bold, maximally separated hues for print and projectors.',
      // Deep, saturated hues that read as both fill and text on white.
      fillLight: ['#c81e1e', '#a34700', '#047857', '#1d4ed8', '#7e22ce', '#334155'],
      inkLight:  ['#c81e1e', '#a34700', '#047857', '#1d4ed8', '#7e22ce', '#334155'],
      fillDark:  ['#ff6b6b', '#f5a742', '#34d399', '#7aa2ff', '#c99bff', '#a9b6c4'],
      inkDark:   ['#ff6b6b', '#f5a742', '#34d399', '#7aa2ff', '#c99bff', '#a9b6c4']
    }
  ];

  var DEFAULT_ID = 'colourblind-safe';

  var byId = {};
  SCHEMES.forEach(function (s) { byId[s.id] = s; });

  function has(id) { return Object.prototype.hasOwnProperty.call(byId, id); }
  function get(id) { return has(id) ? byId[id] : byId[DEFAULT_ID]; }
  function list() {
    return SCHEMES.map(function (s) { return { id: s.id, label: s.label, note: s.note }; });
  }

  function hexToRgbStr(h) {
    h = String(h).replace('#', '');
    return parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
  }

  // Concrete "r,g,b" strings (from the light chart fills) for BED itemRgb, which
  // is a plain-text file with no CSS vars and is typically viewed on a light
  // genome-browser track. Indexed like --codon-N.
  function bedPalette(id) { return get(id).fillLight.map(hexToRgbStr); }

  // Stamp the scheme onto <html> for the given effective theme ('dark' | 'light').
  function apply(id, theme) {
    var s = get(id);
    var fill = theme === 'dark' ? s.fillDark : s.fillLight;
    var ink = theme === 'dark' ? s.inkDark : s.inkLight;
    var root = document.documentElement;
    for (var i = 0; i < 6; i++) {
      root.style.setProperty('--codon-' + (i + 1), fill[i]);
      root.style.setProperty('--codon-' + (i + 1) + '-ink', ink[i]);
    }
    return s.id;
  }

  global.CodonPalettes = {
    SCHEMES: SCHEMES,
    DEFAULT_ID: DEFAULT_ID,
    has: has,
    get: get,
    list: list,
    bedPalette: bedPalette,
    apply: apply
  };
})(typeof window !== 'undefined' ? window : this);
