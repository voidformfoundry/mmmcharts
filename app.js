/* MindMonitor EEG Viewer — parses a Mind Monitor CSV in the browser and charts it with uPlot. */
(() => {
  'use strict';

  // ---------- palette (validated categorical hues; assignments below pass the adjacent-pair checks) ----------
  const PALETTE = {
    light: { blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a', yellow: '#eda100', magenta: '#e87ba4', green: '#008300', violet: '#4a3aa7', red: '#e34948' },
    dark:  { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', yellow: '#c98500', magenta: '#d55181', green: '#008300', violet: '#9085e9', red: '#e66767' },
  };
  const CHROME = {
    light: { grid: '#e1e0d9', axis: '#c3c2b7', tick: '#898781', surface: '#fcfcfb', neutral: '#6b6a66', ramp: ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'] },
    dark:  { grid: '#2c2c2a', axis: '#383835', tick: '#898781', surface: '#1a1a19', neutral: '#a6a49c', ramp: ['#0d366b', '#1c5cab', '#3987e5', '#86b6ef', '#cde2fb'] },
  };
  const SENSORS = ['TP9', 'AF7', 'AF8', 'TP10'];
  const BANDS = ['Delta', 'Theta', 'Alpha', 'Beta', 'Gamma'];
  const BAND_HZ = { Delta: '1–4 Hz', Theta: '4–8 Hz', Alpha: '7.5–13 Hz', Beta: '13–30 Hz', Gamma: '30–44 Hz' };
  const BAND_HUE = { Delta: 'magenta', Theta: 'blue', Alpha: 'aqua', Beta: 'violet', Gamma: 'yellow' };
  const SENSOR_HUE = { TP9: 'blue', AF7: 'aqua', AF8: 'orange', TP10: 'violet' };
  const XYZ_HUE = ['blue', 'orange', 'aqua'];
  const EVENT_HUE = { blink: 'blue', jaw: 'orange' };
  const FINE_BUCKETS = 1500;   // buckets for the zoomed-in region (2 points each)
  const COARSE_BUCKETS = 800;  // buckets for the out-of-view regions

  const $ = id => document.getElementById(id);
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const mode = () => (darkMq.matches ? 'dark' : 'light');
  const col = hue => PALETTE[mode()][hue];

  // ---------- state ----------
  let session = null;
  let charts = [];
  let showEvents = false;
  let smoothSec = 10;
  let electrodeBand = 'Alpha';
  let relativeMode = false;      // plot bands as change from their own baseline
  let baselineMode = 'median';   // 'median' | 'first1' | 'first2' | 'first5'
  let moreOpen = false;
  let resizeRaf = 0;
  const smoothCache = new Map();

  // ---------- helpers ----------
  const yieldToUI = () => new Promise(r => setTimeout(r, 0));
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const pad3 = n => (n < 10 ? '00' : n < 100 ? '0' : '') + n;

  function fmtDateTime(sec, withMs = true) {
    if (sec == null || !isFinite(sec)) return '';
    const d = new Date(sec * 1000);
    let s = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (withMs) s += '.' + pad3(d.getMilliseconds());
    return s;
  }
  function fmtClock(sec) {
    const d = new Date(sec * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function fmtNum(v, digits = 4) {
    if (v == null || Number.isNaN(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-4) return v.toExponential(2);
    return String(Number(v.toPrecision(digits)));
  }
  function fmtLegend(v) { // fixed decimals so legend cells never change width while hovering
    if (v == null || Number.isNaN(v)) return '—';
    const a = Math.abs(v);
    return a >= 10000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : v.toFixed(3);
  }
  function fmtSigned(v) { return v == null || Number.isNaN(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2); }
  function fmtBytes(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
  function fmtInt(n) { return n.toLocaleString(); }
  function fmtX(v) { return v == null ? '' : `${v.toFixed(2)} min · ${fmtClock(session.t0 + v * 60)}`; }
  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hexToRgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; }
  function luminance(hex) { const n = parseInt(hex.slice(1), 16); const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); }
  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = sh => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
    return '#' + [16, 8, 0].map(sh => ch(sh).toString(16).padStart(2, '0')).join('');
  }
  function rampColor(t) { const r = CHROME[mode()].ramp; t = Math.min(1, Math.max(0, t)); const p = t * (r.length - 1), i = Math.min(r.length - 2, Math.floor(p)); return mixHex(r[i], r[i + 1], p - i); }

  // ---------- timestamp parsing ("2026-08-26 20:33:12.610", local time) ----------
  function parseTimestamp(s) {
    if (s.length >= 19 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45 && s.charCodeAt(13) === 58) {
      const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
      const h = +s.slice(11, 13), mi = +s.slice(14, 16), se = +s.slice(17, 19);
      let ms = 0;
      if (s.length > 20 && s.charCodeAt(19) === 46) ms = Math.round(parseFloat('0' + s.slice(19)) * 1000);
      const t = new Date(y, mo - 1, d, h, mi, se, ms).getTime();
      if (!Number.isNaN(t)) return t;
    }
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isNaN(t) ? Date.parse(s) : t;
  }

  // ---------- CSV parsing ----------
  async function parseCsv(text, onProgress) {
    const len = text.length;
    let nl = text.indexOf('\n'); if (nl < 0) nl = len;
    let headerLine = text.slice(0, nl);
    if (headerLine.charCodeAt(0) === 0xFEFF) headerLine = headerLine.slice(1);
    if (headerLine.endsWith('\r')) headerLine = headerLine.slice(0, -1);
    const headers = headerLine.split(',').map(h => h.trim());
    const nCols = headers.length;
    const tsIdx = headers.findIndex(h => /^time\s*stamp$/i.test(h));
    if (tsIdx < 0) throw new Error('No "TimeStamp" column found in the header. Is this a Mind Monitor CSV export?');
    const elemIdx = headers.findIndex(h => /^elements?$/i.test(h));
    const numIdx = [];
    for (let i = 0; i < nCols; i++) if (i !== tsIdx && i !== elemIdx) numIdx.push(i);

    let cap = 4096, n = 0;
    let times = new Float64Array(cap);
    let cols = numIdx.map(() => new Float32Array(cap));
    const grow = () => {
      cap *= 2;
      const nt = new Float64Array(cap); nt.set(times); times = nt;
      cols = cols.map(c => { const nc = new Float32Array(cap); nc.set(c); return nc; });
    };
    const events = [];
    const fields = new Array(nCols);
    let pos = nl + 1, lineNo = 1, badLines = 0, eventRows = 0;

    while (pos < len) {
      let end = text.indexOf('\n', pos); if (end < 0) end = len;
      let lineEnd = end;
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
      if (lineEnd > pos) {
        let f = 0, p = pos;
        while (f < nCols) {
          let c = f === nCols - 1 ? lineEnd : text.indexOf(',', p);
          if (c < 0 || c > lineEnd) c = lineEnd;
          fields[f++] = text.slice(p, c);
          p = c + 1;
          if (c >= lineEnd) break;
        }
        for (; f < nCols; f++) fields[f] = '';
        const t = parseTimestamp(fields[tsIdx]);
        if (Number.isNaN(t)) {
          badLines++;
        } else {
          if (n >= cap) grow();
          let any = false;
          for (let k = 0; k < numIdx.length; k++) {
            const s = fields[numIdx[k]];
            let v = NaN;
            if (s.length) { v = +s; if (Number.isNaN(v)) v = NaN; else any = true; }
            cols[k][n] = v;
          }
          const ev = elemIdx >= 0 ? fields[elemIdx].trim() : '';
          if (ev) { events.push({ t: t / 1000, text: ev }); if (!any) eventRows++; }
          if (any) { times[n] = t / 1000; n++; }
        }
      }
      pos = end + 1; lineNo++;
      if ((lineNo & 0x3fff) === 0) { onProgress(pos / len); await yieldToUI(); }
    }
    onProgress(1);

    times = times.subarray(0, n);
    cols = cols.map(c => c.subarray(0, n));

    let sorted = true;
    for (let i = 1; i < n; i++) if (times[i] < times[i - 1]) { sorted = false; break; }
    if (!sorted) {
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => times[a] - times[b]);
      const nt = new Float64Array(n); for (let i = 0; i < n; i++) nt[i] = times[order[i]];
      times = nt;
      cols = cols.map(c => { const nc = new Float32Array(n); for (let i = 0; i < n; i++) nc[i] = c[order[i]]; return nc; });
    }
    events.sort((a, b) => a.t - b.t);

    const columns = numIdx.map((hi, k) => {
      const data = cols[k];
      let min = Infinity, max = -Infinity, sum = 0, count = 0, nonzero = 0;
      for (let i = 0; i < n; i++) {
        const v = data[i];
        if (v === v) { count++; sum += v; if (v < min) min = v; if (v > max) max = v; if (v !== 0) nonzero++; }
      }
      return { name: headers[hi], data, min: count ? min : NaN, max: count ? max : NaN, mean: count ? sum / count : NaN, count, nonzero };
    });

    return { headers, tsName: headers[tsIdx], times, columns, events, rows: n, eventRows, badLines, totalLines: lineNo - 1 };
  }

  // ---------- derived data ----------
  function colByName(cols, re) { return cols.find(c => re.test(c.name)) || null; }
  function hasData(c) { return !!c && c.count > 0; }
  function hasNonzero(c) { return !!c && c.nonzero > 0; }

  function meanOf(arrays, n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (const a of arrays) { const v = a[i]; if (v === v) { s += v; c++; } }
      out[i] = c ? s / c : NaN;
    }
    return out;
  }

  function movingAverage(arr, win) {
    const n = arr.length, out = new Float32Array(n), half = win >> 1;
    const ps = new Float64Array(n + 1), pc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const v = arr[i], ok = v === v; ps[i + 1] = ps[i] + (ok ? v : 0); pc[i + 1] = pc[i] + (ok ? 1 : 0); }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1), c = pc[b] - pc[a];
      out[i] = c ? (ps[b] - ps[a]) / c : NaN;
    }
    return out;
  }
  function winSamples() {
    if (!smoothSec || !session || !isFinite(session.interval) || session.interval <= 0) return 1;
    let w = Math.round(smoothSec / session.interval);
    if (w < 2) return 1;
    return w % 2 === 0 ? w + 1 : w;
  }
  function smoothed(arr) {
    const w = winSamples();
    if (w <= 1) return arr;
    let byWin = smoothCache.get(arr);
    if (!byWin) { byWin = new Map(); smoothCache.set(arr, byWin); }
    let out = byWin.get(w);
    if (!out) { out = movingAverage(arr, w); byWin.set(w, out); }
    return out;
  }

  function robustStats(data) {
    const n = data.length, step = Math.max(1, Math.floor(n / 20000)), vals = [];
    for (let i = 0; i < n; i += step) { const v = data[i]; if (v === v) vals.push(v); }
    if (!vals.length) return { median: 0, spread: 1 };
    vals.sort((a, b) => a - b);
    const median = vals[vals.length >> 1];
    const dev = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    return { median, spread: dev[Math.floor(dev.length * 0.95)] || 1 };
  }

  // ---------- baselines, ratios and the ×/÷ axis ----------
  const LOG2 = Math.log10(2);
  // Tick steps in minutes, coarse enough to stay readable when the plot is narrow.
  const MINUTE_INCRS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  function baselineOf(arr) {
    if (baselineMode !== 'median' && session) {
      const mins = +baselineMode.slice(5), n = upperBound(session.tmin, mins);
      let sum = 0, c = 0;
      for (let i = 0; i < n; i++) { const v = arr[i]; if (v === v) { sum += v; c++; } }
      if (c) return sum / c;
    }
    return robustStats(arr).median;
  }
  function baselineLabel() { return baselineMode === 'median' ? 'session median' : `first ${baselineMode.slice(5)} min`; }
  function shifted(arr, base) { const out = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[i] - base; return out; }
  function diffSeries(a, b) { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i]; return out; }
  function minMaxOf(arrays) { let min = Infinity, max = -Infinity; for (const a of arrays) for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === v) { if (v < min) min = v; if (v > max) max = v; } } return [min, max]; }
  // axis ticks at doublings (…, ÷4, ÷2, baseline, ×2, ×4, …) for series measured in Bels from a reference
  function doublingSplits(u, axisIdx, min, max) {
    const span = (max - min) / LOG2, mult = span <= 7 ? 1 : span <= 14 ? 2 : span <= 28 ? 4 : 8, step = LOG2 * mult, out = [];
    for (let k = Math.ceil(min / step - 1e-9); k * step <= max + 1e-9; k++) out.push(k * step);
    return out;
  }
  function ratioLabel(bel, zero) {
    if (Math.abs(bel) < 1e-6) return zero;
    const r = Math.pow(10, Math.abs(bel));
    return (bel > 0 ? '×' : '÷') + (r >= 10 ? r.toFixed(0) : Number(r.toFixed(2)).toString());
  }
  const relValue = (u, v) => (v == null ? '—' : `${fmtSigned(v)} · ${v >= 0 ? '×' : '÷'}${Math.pow(10, Math.abs(v)).toFixed(2)}`);
  const ratioValue = (u, v) => (v == null ? '—' : Math.pow(10, v).toFixed(2) + '×');

  function prepareSession(s) {
    const n = s.rows, cols = s.columns;
    s.t0 = s.times[0];
    s.tmin = new Float64Array(n);
    for (let i = 0; i < n; i++) s.tmin[i] = (s.times[i] - s.t0) / 60;
    // median sample interval (seconds)
    let interval = NaN;
    if (n > 2) {
      const step = Math.max(1, Math.floor(n / 5000)), dts = [];
      for (let i = step; i < n; i += step) dts.push((s.times[i] - s.times[i - step]) / step);
      dts.sort((a, b) => a - b); interval = dts[dts.length >> 1];
    }
    s.interval = interval;
    // events in minutes since start
    s.eventIndex = { blink: [], jaw: [], marker: [], other: [] };
    for (const e of s.events) {
      const m = (e.t - s.t0) / 60;
      if (/blink/i.test(e.text)) s.eventIndex.blink.push(m);
      else if (/jaw/i.test(e.text)) s.eventIndex.jaw.push(m);
      else if (/marker/i.test(e.text)) s.eventIndex.marker.push(m);
      else s.eventIndex.other.push(m);
    }
    const connected = s.events.find(e => /connected/i.test(e.text) && !/disconnected/i.test(e.text));
    s.device = connected ? connected.text.replace(/^\S+\s*/, '').trim() : '';
    // band powers
    s.used = new Set();
    const take = c => { if (c) s.used.add(c); return c; };
    s.bandCols = {};
    for (const b of BANDS) s.bandCols[b] = SENSORS.map(sn => ({ sn, col: take(colByName(cols, new RegExp(`^${b}_${sn}$`, 'i'))) })).filter(x => hasData(x.col));
    s.bandsPresent = BANDS.filter(b => s.bandCols[b].length);
    s.sensorsPresent = SENSORS.filter(sn => s.bandsPresent.some(b => s.bandCols[b].some(x => x.sn === sn)));
    s.bandMean = {};
    for (const b of s.bandsPresent) s.bandMean[b] = meanOf(s.bandCols[b].map(x => x.col.data), n);
    // raw EEG
    s.rawCols = SENSORS.map(sn => ({ sn, col: take(colByName(cols, new RegExp(`^RAW_${sn}$`, 'i'))) })).filter(x => hasData(x.col));
    // heart rate (0 = no reading)
    const hr = take(colByName(cols, /^Heart[_ ]?Rate$/i));
    s.hr = null;
    if (hr) {
      const data = new Float32Array(n); let sum = 0, c = 0;
      for (let i = 0; i < n; i++) { const v = hr.data[i]; if (v === v && v > 0) { data[i] = v; sum += v; c++; } else data[i] = NaN; }
      s.hr = { col: hr, data, mean: c ? sum / c : NaN, count: c };
    }
    // accelerometer & movement magnitude |Δg|
    s.accel = ['X', 'Y', 'Z'].map((ax, i) => ({ ax, col: take(colByName(cols, new RegExp(`^Accelerometer_${ax}$`, 'i'))), hue: XYZ_HUE[i] })).filter(x => hasData(x.col));
    s.movement = null;
    if (s.accel.length === 3) {
      const [ax, ay, az] = s.accel.map(x => x.col.data), mv = new Float32Array(n);
      mv[0] = NaN;
      for (let i = 1; i < n; i++) {
        const dx = ax[i] - ax[i - 1], dy = ay[i] - ay[i - 1], dz = az[i] - az[i - 1];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        mv[i] = d === d ? d : NaN;
      }
      s.movement = mv;
    }
    s.gyro = ['X', 'Y', 'Z'].map((ax, i) => ({ ax, col: take(colByName(cols, new RegExp(`^Gyro_${ax}$`, 'i'))), hue: XYZ_HUE[i] })).filter(x => hasData(x.col));
    s.aux = cols.filter(c => /^AUX[_ ]?\d+$/i.test(c.name) && hasData(c)).map(take);
    s.optics = cols.filter(c => /^Optics\s*\d+$/i.test(c.name)).map(take);
    s.hsi = SENSORS.map(sn => ({ sn, col: take(colByName(cols, new RegExp(`^HSI_${sn}$`, 'i'))) })).filter(x => hasData(x.col));
    s.headband = take(colByName(cols, /^HeadBandOn$/i));
    s.battery = take(colByName(cols, /^Battery$/i));
    s.other = cols.filter(c => !s.used.has(c) && hasData(c));
    s.nanArray = new Float32Array(n).fill(NaN);
  }

  // ---------- multi-resolution view (min/max decimation) ----------
  function pushRegion(x, ys, a, b, buckets, outX, outYs) {
    const n = b - a;
    if (n <= 0) return;
    if (n <= 2 * buckets) {
      for (let i = a; i < b; i++) {
        outX.push(x[i]);
        for (let j = 0; j < ys.length; j++) { const v = ys[j][i]; outYs[j].push(v === v ? v : null); }
      }
      return;
    }
    const size = n / buckets;
    for (let k = 0; k < buckets; k++) {
      const s = a + Math.floor(k * size), e = k === buckets - 1 ? b : a + Math.floor((k + 1) * size);
      outX.push(x[s], x[e - 1]);
      for (let j = 0; j < ys.length; j++) {
        const y = ys[j];
        let min = Infinity, max = -Infinity, imin = -1, imax = -1;
        for (let i = s; i < e; i++) { const v = y[i]; if (v === v) { if (v < min) { min = v; imin = i; } if (v > max) { max = v; imax = i; } } }
        if (imin < 0) outYs[j].push(null, null);
        else if (imin <= imax) outYs[j].push(min, max);
        else outYs[j].push(max, min);
      }
    }
  }

  function buildView(chart, xmin, xmax) {
    const { x, ys } = chart.full;
    const N = x.length;
    if (N <= 2 * FINE_BUCKETS + 2 * COARSE_BUCKETS) {
      if (!chart.staticView) { const outX = [], outYs = ys.map(() => []); pushRegion(x, ys, 0, N, N, outX, outYs); chart.staticView = [outX, ...outYs]; }
      return { key: 'static', data: chart.staticView };
    }
    let i0 = Math.max(0, lowerBound(x, xmin) - 1), i1 = Math.min(N, upperBound(x, xmax) + 1);
    if (!(xmin < xmax)) { i0 = 0; i1 = N; }
    const key = i0 + ':' + i1;
    if (key === chart.viewKey) return null;
    const outX = [], outYs = ys.map(() => []);
    pushRegion(x, ys, 0, i0, COARSE_BUCKETS, outX, outYs);
    pushRegion(x, ys, i0, i1, FINE_BUCKETS, outX, outYs);
    pushRegion(x, ys, i1, N, COARSE_BUCKETS, outX, outYs);
    return { key, data: [outX, ...outYs] };
  }

  function refreshView(chart) {
    if (!chart.full || !chart.u) return;
    const u = chart.u;
    const v = buildView(chart, u.scales.x.min, u.scales.x.max);
    if (!v || v.key === chart.viewKey) return;
    chart.viewKey = v.key;
    const { min, max } = u.scales.x;
    u.setData(v.data, false);
    u.setScale('x', { min, max });
  }

  // ---------- uPlot construction ----------
  function axisSize(u, values, axisIdx, cycleNum) {
    const axis = u.axes[axisIdx];
    if (cycleNum > 1) return axis._size;
    let size = axis.ticks.size + axis.gap;
    const longest = (values ?? []).reduce((a, v) => (String(v).length > a.length ? String(v) : a), '');
    if (longest !== '') { u.ctx.font = axis.font[0]; size += u.ctx.measureText(longest).width / devicePixelRatio; }
    return Math.ceil(size);
  }

  function makeOptions(spec, width) {
    const ch = CHROME[mode()];
    const font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    const base = { stroke: ch.tick, font, labelFont: font, grid: { show: true, stroke: ch.grid, width: 1 }, ticks: { show: true, stroke: ch.axis, width: 1, size: 6 }, gap: 6 };
    const xAxis = { ...base, space: spec.xSpace ?? 70 };
    // A stacked strip hides its tick labels but keeps the axis, because uPlot drops an axis's
    // gridlines along with the axis itself; size 0 means it still takes no vertical room.
    if (spec.hideXAxis) {
      xAxis.size = 0;
      xAxis.gap = 0;
      xAxis.ticks = { ...base.ticks, show: false };
      xAxis.values = (u, splits) => splits.map(() => '');
    } else {
      xAxis.label = spec.xLabel ?? 'time (min)';
      xAxis.labelSize = 18;
      xAxis.labelGap = 2;
    }
    // Allowed tick steps in minutes; uPlot picks the smallest that still clears `space`,
    // so a wide chart lands on 5-minute lines and a narrow one falls back to 10, 15 or 30.
    if (spec.xIncrs) xAxis.incrs = spec.xIncrs;
    const yAxis = { ...base, size: spec.yAxisSize ?? axisSize };
    if (spec.yLabel) { yAxis.label = spec.yLabel; yAxis.labelSize = 18; yAxis.labelGap = 4; }
    if (spec.ySplits || spec.ySplitsFn) {
      yAxis.splits = spec.ySplitsFn || (() => spec.ySplits);
      yAxis.values = (u, splits) => splits.map(v => (typeof spec.yValues === 'function' ? spec.yValues(v) : spec.yValues?.[v]) ?? v);
    }
    const scales = { x: { time: false }, y: {} };
    if (spec.yRange) scales.y.range = spec.yRange;

    const series = [{ label: 'Time', value: (u, v) => fmtX(v) }];
    for (const s of spec.series) {
      series.push({
        label: s.label, stroke: s.color, width: s.width ?? 2, alpha: s.alpha ?? 1, spanGaps: true, scale: 'y',
        paths: s.noPath ? () => null : s.stepped ? uPlot.paths.stepped({ align: 1 }) : undefined,
        fill: s.fill,
        points: s.noPath ? { show: false } : { size: 8, width: 2, stroke: ch.surface, fill: s.color },
        value: s.value ?? ((u, v) => fmtLegend(v)),
      });
    }
    const hooks = {
      setScale: [(u, key) => { if (key === 'x' && u._chart) setTimeout(() => refreshView(u._chart), 0); }],
      setSelect: [u => {
        // drag-to-zoom on this chart: apply the same time range to every other chart (cursors stay independent)
        const sel = u.select;
        if (sel.width > 0) syncZoom(u, u.posToVal(sel.left, 'x'), u.posToVal(sel.left + sel.width, 'x'));
      }],
      draw: [drawEventMarkers],
    };
    if (spec.refLine != null) hooks.draw.push(drawRefLine);
    if (spec.draw) hooks.draw.push(spec.draw);
    if (spec.onCursor) hooks.setCursor = [spec.onCursor];
    return {
      width, height: spec.height || 220,
      padding: spec.padding ?? [10, 14, spec.hideXAxis ? 4 : 0, 4],
      cursor: {
        drag: { x: true, y: false },
        focus: { prox: spec.focus === false ? -1 : 30 },
        points: { size: 10, width: 2, stroke: () => ch.surface, fill: (u, i) => u.series[i]._stroke || u.series[i].stroke(u, i) },
      },
      focus: { alpha: 0.1 }, // hovered series stays solid, the others drop to 10%
      select: { show: true },
      legend: { show: spec.legend !== false, live: true },
      scales, axes: [xAxis, yAxis], series, hooks,
    };
  }

  function drawEventMarkers(u) {
    if (!showEvents || !session || !u._chart || u._chart.spec.id === 'events') return;
    const evs = session.eventIndex;
    if (!evs.blink.length && !evs.jaw.length) return;
    const { ctx, bbox } = u;
    const xmin = u.scales.x.min, xmax = u.scales.x.max;
    ctx.save();
    ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
    ctx.lineWidth = 1;
    for (const kind of ['blink', 'jaw']) {
      const ts = evs[kind];
      const a = lowerBound(ts, xmin), b = upperBound(ts, xmax);
      if (b <= a) continue;
      ctx.strokeStyle = kind === 'blink' ? CHROME[mode()].neutral : col(EVENT_HUE.jaw);
      ctx.globalAlpha = kind === 'blink' ? 0.4 : 0.9;
      ctx.beginPath();
      for (let i = a; i < b; i++) {
        const x = Math.round(u.valToPos(ts[i], 'x', true)) + 0.5;
        ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRefLine(u) {
    const v = u._chart && u._chart.spec.refLine;
    if (v == null || !isFinite(v)) return;
    const { ctx, bbox } = u, dpr = devicePixelRatio;
    const y = Math.round(u.valToPos(v, 'y', true)) + 0.5;
    if (y < bbox.top || y > bbox.top + bbox.height) return;
    ctx.save();
    ctx.strokeStyle = CHROME[mode()].tick; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke();
    ctx.restore();
  }

  function drawEventTicks(u) {
    const s = session, { ctx, bbox } = u, dpr = devicePixelRatio, H = bbox.height;
    const xmin = u.scales.x.min, xmax = u.scales.x.max;
    const lanes = [
      { kind: 'blink', label: 'blink', y0: 0.64, y1: 0.76, lw: 1.5 },
      { kind: 'jaw', label: 'jaw', y0: 0.10, y1: 0.24, lw: 3 },
    ];
    ctx.save();
    ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
    for (const lane of lanes) {
      const si = u.series.findIndex(x => x._kind === lane.kind);
      if (si < 0 || !u.series[si].show) continue;
      const ts = s.eventIndex[lane.kind];
      const a = lowerBound(ts, xmin), b = upperBound(ts, xmax);
      if (b <= a) continue;
      ctx.strokeStyle = col(EVENT_HUE[lane.kind]);
      ctx.lineWidth = lane.lw * dpr;
      ctx.beginPath();
      for (let i = a; i < b; i++) {
        const x = Math.round(u.valToPos(ts[i], 'x', true)) + 0.5;
        ctx.moveTo(x, bbox.top + lane.y0 * H); ctx.lineTo(x, bbox.top + lane.y1 * H);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    ctx.font = `${11 * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = CHROME[mode()].tick; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const lane of lanes) {
      const si = u.series.findIndex(x => x._kind === lane.kind);
      if (si < 0 || !u.series[si].show) continue;
      ctx.fillText(lane.label, bbox.left + bbox.width + 6 * dpr, bbox.top + ((lane.y0 + lane.y1) / 2) * H);
    }
    ctx.restore();
  }

  function createChart(spec, plotEl) {
    const chart = { spec, el: plotEl, u: null, viewKey: null, staticView: null };
    chart.full = { x: session.tmin, ys: spec.series.map(s => s.data) };
    const v = buildView(chart, -Infinity, Infinity);
    chart.viewKey = v.key;
    plotEl.style.setProperty('--legend-w', spec.legendWidth || '9ch');
    const u = new uPlot(makeOptions(spec, Math.max(200, plotEl.clientWidth)), v.data, plotEl);
    spec.series.forEach((s, i) => { if (s.kind) u.series[i + 1]._kind = s.kind; });
    u._chart = chart; chart.u = u;
    u.over.addEventListener('dblclick', () => { const d = u.data[0]; if (d.length) syncZoom(u, d[0], d[d.length - 1]); });
    charts.push(chart);
    return chart;
  }

  function syncZoom(src, min, max) {
    if (!(min < max)) return;
    for (const c of charts) {
      if (c.u === src) continue;
      const sc = c.u.scales.x;
      if (sc.min !== min || sc.max !== max) c.u.setScale('x', { min, max });
    }
  }

  // ---------- chart specs ----------
  function smoothLabel() { return smoothSec ? `${smoothSec} s moving average` : 'unsmoothed'; }

  function mainBlocks() {
    const s = session, blocks = [];
    const bands = s.bandsPresent;
    if (bands.length) {
      const nS = s.sensorsPresent.length;
      const rel = relativeMode, base = {};
      if (rel) for (const b of bands) base[b] = baselineOf(s.bandMean[b]);
      const relAxis = rel ? { ySplitsFn: doublingSplits, yValues: v => ratioLabel(v, 'baseline'), legendWidth: '14ch' } : {};
      blocks.push({ type: 'section', title: 'Band power' });
      blocks.push({ type: 'chart', spec: {
        id: 'bands', title: rel ? 'Band powers over time · relative to baseline' : 'Band powers over time',
        subtitle: rel
          ? `Change of each band from its own baseline (${baselineLabel()}), averaged across the ${nS} electrode${nS === 1 ? '' : 's'} · ${smoothLabel()} · +0.3 Bel = ×2 power`
          : `Absolute log power (Bels), averaged across the ${nS} electrode${nS === 1 ? '' : 's'} · ${smoothLabel()}`,
        height: 300, yLabel: rel ? 'change from baseline (× power)' : `log power (avg of ${nS} electrodes)`, refLine: rel ? 0 : undefined, ...relAxis,
        series: bands.map(b => ({ label: b, data: rel ? shifted(smoothed(s.bandMean[b]), base[b]) : smoothed(s.bandMean[b]), color: col(BAND_HUE[b]), value: rel ? relValue : undefined })),
      } });
      let stripRange = null;
      if (rel) { const [lo, hi] = minMaxOf(bands.map(b => shifted(smoothed(s.bandMean[b]), base[b]))); const pad = (hi - lo || 1) * 0.12; stripRange = [lo - pad, hi + pad]; }
      blocks.push({ type: 'strips', id: 'band-detail', title: rel ? 'Band powers — per band detail · relative to baseline' : 'Band powers — per band detail',
        subtitle: rel
          ? `All bands on one shared scale as change from their own baseline (${baselineLabel()}) · thin = raw samples, thick = ${smoothLabel()} · dashed = baseline · gridlines every 5 min · +0.3 Bel = ×2, +1 Bel = ×10`
          : `Each band on its own scale, averaged across electrodes · thin = raw samples, thick = ${smoothLabel()} · dashed = that band's session median · gridlines every 5 min · 0 Bel = 1 µV²`,
        strips: bands.map((b, i) => {
          const med = robustStats(s.bandMean[b]).median;
          return {
            id: 'strip-' + b, label: b, sub: BAND_HZ[b], color: col(BAND_HUE[b]),
            refLine: rel ? 0 : med, sub2: rel ? 'baseline ' + fmtSigned(base[b]) : 'median ' + fmtSigned(med),
            height: i === bands.length - 1 ? 188 : 140, hideXAxis: i < bands.length - 1, yAxisSize: 56, legend: false, focus: false,
            xIncrs: MINUTE_INCRS, xSpace: 46,
            yRange: stripRange || undefined, ...relAxis,
            series: [
              { label: b + ' raw', data: rel ? shifted(s.bandMean[b], base[b]) : s.bandMean[b], color: col(BAND_HUE[b]), width: 1, alpha: 0.35, value: rel ? relValue : undefined },
              { label: b, data: rel ? shifted(smoothed(s.bandMean[b]), base[b]) : smoothed(s.bandMean[b]), color: col(BAND_HUE[b]), width: 2, value: rel ? relValue : undefined },
            ],
          };
        }),
      });
      blocks.push({ type: 'chart', spec: electrodeSpec(electrodeBand) });
      blocks.push({ type: 'bmc' });
      if (['Alpha', 'Theta', 'Beta'].every(b => bands.includes(b))) {
        const A = smoothed(s.bandMean.Alpha), T = smoothed(s.bandMean.Theta), B = smoothed(s.bandMean.Beta);
        blocks.push({ type: 'section', title: 'Derived indices' });
        blocks.push({ type: 'chart', spec: {
          id: 'indices', title: 'Relaxation & focus indices',
          subtitle: `Power ratios from the electrode-averaged band powers: relaxation = alpha ÷ theta, focus = beta ÷ theta · read both together: the gap between them is alpha ÷ beta · dashed line = equal power (1:1) · ${smoothLabel()}`,
          height: 280, yLabel: 'power ratio', refLine: 0, ySplitsFn: doublingSplits, yValues: v => ratioLabel(v, '1:1'), legendWidth: '9ch',
          series: [
            { label: 'Relaxation (alpha : theta)', data: diffSeries(A, T), color: col('aqua'), value: ratioValue },
            { label: 'Focus (beta : theta)', data: diffSeries(B, T), color: col('violet'), value: ratioValue },
          ],
        } });
      }
    }

    const items = [];
    if (s.hr) {
      if (s.hr.count) items.push({ type: 'chart', spec: {
        id: 'hr', title: `Heart rate · mean ${Math.round(s.hr.mean)} bpm`,
        subtitle: `Beats per minute from the optical sensors · ${smoothLabel()}`, height: 240, yLabel: 'bpm', focus: false,
        series: [{ label: 'Heart rate', data: smoothed(s.hr.data), color: col('red'), fill: hexToRgba(col('red'), mode() === 'dark' ? 0.22 : 0.14) }],
      } });
      else items.push({ type: 'note', title: 'Heart rate', text: 'A Heart_Rate column is present but every value is 0 — no heart-rate data was recorded in this session.' });
    }
    if (bands.length && s.sensorsPresent.length) items.push({ type: 'heatmap', id: 'heat', title: 'Session band averages · mean log-power', subtitle: 'Mean of each band per electrode over the whole session, in Bels' });
    if (items.length) {
      blocks.push({ type: 'section', title: 'Heart rate & session averages' });
      blocks.push({ type: 'grid2', items });
    }

    const nb = s.eventIndex.blink.length, nj = s.eventIndex.jaw.length;
    if (s.movement || nb || nj) {
      blocks.push({ type: 'section', title: 'Events & movement' });
      const series = [];
      if (s.movement) series.push({ label: 'movement', data: s.movement, color: CHROME[mode()].neutral, width: 1 });
      if (nb) series.push({ label: `blinks (${fmtInt(nb)})`, data: s.nanArray, color: col(EVENT_HUE.blink), noPath: true, kind: 'blink', value: () => '' });
      if (nj) series.push({ label: `jaw clenches (${fmtInt(nj)})`, data: s.nanArray, color: col(EVENT_HUE.jaw), noPath: true, kind: 'jaw', value: () => '' });
      blocks.push({ type: 'chart', spec: {
        id: 'events', title: 'Events & movement · blinks · jaw clenches · accelerometer',
        subtitle: s.movement ? 'Blink and jaw-clench events from the headband, over head movement (change in acceleration between samples, in g)' : 'Blink and jaw-clench events from the headband',
        height: 240, yLabel: s.movement ? '|Δ g|' : undefined, yRange: s.movement ? undefined : [0, 1], padding: [10, 52, 0, 4], focus: false, draw: drawEventTicks, series,
      } });
    }

    if (s.rawCols.length) {
      blocks.push({ type: 'section', title: 'Raw EEG' });
      blocks.push({ type: 'chart', spec: rawStackSpec() });
    }
    return blocks;
  }

  function electrodeSpec(band) {
    const s = session, bands = s.bandsPresent;
    const eb = bands.includes(band) ? band : bands[0];
    const rel = relativeMode;
    return {
      id: 'by-electrode', title: rel ? `${eb} by electrode · relative to baseline` : `${eb} by electrode`, bandSelect: { value: eb, options: bands },
      subtitle: `Left side: TP9 (behind ear), AF7 (forehead) · right side: AF8 (forehead), TP10 (behind ear) · ${smoothLabel()}` + (rel ? ` · each electrode relative to its own ${baselineLabel()}` : ''),
      height: 280, yLabel: rel ? 'change from baseline (× power)' : `${eb.toLowerCase()} log power`,
      refLine: rel ? 0 : undefined, ...(rel ? { ySplitsFn: doublingSplits, yValues: v => ratioLabel(v, 'baseline'), legendWidth: '14ch' } : {}),
      series: s.bandCols[eb].map(x => ({ label: x.sn, data: rel ? shifted(smoothed(x.col.data), baselineOf(x.col.data)) : smoothed(x.col.data), color: col(SENSOR_HUE[x.sn]), value: rel ? relValue : undefined })),
    };
  }

  function replaceChart(chart, spec) {
    const { min, max } = chart.u.scales.x;
    const full = chart.u.data[0];
    const zoomed = full.length && (min !== full[0] || max !== full[full.length - 1]);
    chart.u.destroy();
    charts = charts.filter(c => c !== chart);
    chart.el.textContent = '';
    const next = createChart(spec, chart.el);
    if (zoomed) next.u.setScale('x', { min, max });
    return next;
  }

  function rawStackSpec() {
    const s = session, chans = s.rawCols, K = chans.length;
    const stats = chans.map(c => robustStats(c.col.data));
    const spacing = Math.max(20, Math.max(...stats.map(st => st.spread)) * 3);
    const offsets = chans.map((c, k) => k * spacing);
    const series = chans.map((c, k) => {
      const off = offsets[k], med = stats[k].median, src = c.col.data, data = new Float32Array(s.rows);
      for (let i = 0; i < s.rows; i++) { const v = src[i]; data[i] = v === v ? v - med + off : NaN; }
      return { label: c.sn, data, color: col(SENSOR_HUE[c.sn]), width: 1.5, value: (u, v) => (v == null ? '—' : fmtLegend(v - off + med) + ' µV') };
    });
    return {
      id: 'raw', title: 'Raw EEG · stacked by electrode · µV',
      subtitle: `Each trace centred on its median and offset by ${fmtNum(spacing, 3)} µV so the electrodes stack; hover for the actual microvolt values`,
      height: 340, yAxisSize: 56, legendWidth: '12ch', yRange: [-spacing * 0.7, (K - 1) * spacing + spacing * 0.7],
      ySplits: offsets, yValues: v => { const k = offsets.indexOf(v); return k >= 0 ? chans[k].sn : ''; }, series,
    };
  }

  function moreBlocks() {
    const s = session, blocks = [];
    const q = [];
    if (s.hsi.length) q.push({ type: 'strips', id: 'hsi', title: 'Sensor contact (horseshoe indicator)', subtitle: '1 = good, 2 = medium, 4 = poor contact, per electrode', strips: s.hsi.map((x, i) => ({
      id: 'hsi-' + x.sn, label: x.sn, color: col(SENSOR_HUE[x.sn]), height: i === s.hsi.length - 1 ? 120 : 90, hideXAxis: i < s.hsi.length - 1, yAxisSize: 56, legend: false, focus: false,
      yRange: [0.6, 4.4], ySplits: [1, 2, 4], yValues: { 1: 'Good', 2: 'Med', 4: 'Poor' },
      series: [{ label: x.sn, data: x.col.data, color: col(SENSOR_HUE[x.sn]), stepped: true, fill: hexToRgba(col(SENSOR_HUE[x.sn]), 0.15), value: (u, v) => (v == null ? '—' : ({ 1: 'Good', 2: 'Medium', 4: 'Poor' })[v] ?? fmtNum(v)) }],
    })) });
    if (hasData(s.headband)) q.push({ type: 'chart', spec: { id: 'headband', title: 'Headband on', subtitle: '1 while the headband detects it is being worn', height: 120, focus: false, yRange: [-0.2, 1.2], ySplits: [0, 1], yValues: { 0: 'Off', 1: 'On' }, series: [{ label: 'Headband on', data: s.headband.data, color: col('green'), stepped: true, fill: hexToRgba(col('green'), 0.15) }] } });
    if (hasData(s.battery)) q.push({ type: 'chart', spec: { id: 'battery', title: 'Battery', subtitle: 'Headband battery level, percent', height: 160, focus: false, yRange: [0, 100], series: [{ label: 'Battery', data: s.battery.data, color: col('blue') }] } });
    if (q.length) { blocks.push({ type: 'section', title: 'Signal quality' }); blocks.push(...q); }

    if (s.other.length) {
      blocks.push({ type: 'section', title: 'Other columns' });
      blocks.push({ type: 'grid2', items: s.other.map(c => ({ type: 'chart', spec: { id: 'col-' + c.name, title: c.name.replace(/_/g, ' '), subtitle: 'Column not recognised as a standard Mind Monitor field, charted as-is', height: 180, focus: false, series: [{ label: c.name, data: c.data, color: col('blue') }] } })) });
    }
    return blocks;
  }

  // ---------- chart explanations (the "?" pop-ups) ----------
  const svgOpen = (w, h) => `<svg viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="11">`;
  function prng(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
  const pathOf = pts => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');

  function headSvg(highlight) {
    const muted = CHROME[mode()].tick;
    const dots = [['TP9', 40, 124], ['AF7', 78, 58], ['AF8', 142, 58], ['TP10', 180, 124]];
    let s = svgOpen(360, 190) + '<g transform="translate(70 0)">';
    s += `<ellipse cx="110" cy="100" rx="70" ry="80" fill="none" stroke="${muted}" stroke-width="1.5"/>`;
    s += `<path d="M100 22 Q110 4 120 22" fill="none" stroke="${muted}" stroke-width="1.5"/>`;
    s += `<path d="M40 86 Q28 100 40 114 M180 86 Q192 100 180 114" fill="none" stroke="${muted}" stroke-width="1.5"/>`;
    s += `<circle cx="110" cy="44" r="3.5" fill="${muted}"/><text x="110" y="34" text-anchor="middle" fill="currentColor" font-size="10">ref (Fpz)</text>`;
    for (const [name, x, y] of dots) {
      const c = col(SENSOR_HUE[name]), hi = !highlight || highlight === name;
      s += `<circle cx="${x}" cy="${y}" r="8" fill="${c}" opacity="${hi ? 1 : 0.3}"/><text x="${x < 110 ? x - 12 : x + 12}" y="${y < 100 ? y - 12 : y + 24}" text-anchor="${y < 100 ? (x < 110 ? 'end' : 'start') : 'middle'}" fill="currentColor" font-weight="600">${name}</text>`;
    }
    s += `<text x="16" y="104" fill="currentColor" font-size="10">L</text><text x="196" y="104" fill="currentColor" font-size="10">R</text>`;
    s += `<text x="110" y="184" text-anchor="middle" fill="currentColor" font-size="10">top view · nose at the top · wearer's left on the left</text>`;
    return s + '</g></svg>';
  }

  function bandsSvg() {
    const ranges = { Delta: [1, 4], Theta: [4, 8], Alpha: [7.5, 13], Beta: [13, 30], Gamma: [30, 44] };
    const muted = CHROME[mode()].tick, x = hz => 24 + (hz / 46) * 320;
    let s = svgOpen(360, 96);
    s += `<line x1="24" y1="72" x2="344" y2="72" stroke="${muted}"/>`;
    for (const hz of [0, 10, 20, 30, 40]) s += `<line x1="${x(hz)}" y1="72" x2="${x(hz)}" y2="76" stroke="${muted}"/><text x="${x(hz)}" y="88" text-anchor="middle" fill="currentColor" font-size="10">${hz}</text>`;
    s += `<text x="352" y="88" text-anchor="end" fill="currentColor" font-size="10">Hz</text>`;
    BANDS.forEach((b, i) => {
      const [a, z] = ranges[b], x0 = x(a), w = x(z) - x0, c = col(BAND_HUE[b]);
      s += `<rect x="${x0}" y="46" width="${Math.max(w - 1, 2)}" height="22" rx="4" fill="${c}" opacity="0.9"/>`;
      s += `<text x="${x0 + w / 2}" y="${i % 2 ? 24 : 40}" text-anchor="middle" fill="currentColor" font-weight="600">${b}</text>`;
    });
    return s + '</svg>';
  }

  function smoothingSvg() {
    const rnd = prng(7), pts = [];
    for (let i = 0; i <= 70; i++) { const t = i / 70; pts.push([20 + t * 320, 48 - 16 * Math.sin(t * 6.3) - 8 * Math.sin(t * 2.1 + 1) + (rnd() - 0.5) * 28]); }
    const sm = pts.map((p, i) => { const a = Math.max(0, i - 4), b = Math.min(pts.length, i + 5); let acc = 0; for (let k = a; k < b; k++) acc += pts[k][1]; return [p[0], acc / (b - a)]; });
    const c = col('aqua');
    return svgOpen(360, 96) + `<path d="${pathOf(pts)}" fill="none" stroke="${c}" stroke-width="1" opacity="0.45"/><path d="${pathOf(sm)}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round"/><text x="20" y="92" fill="currentColor" font-size="10">thin = every sample · thick = moving average (set with the Smoothing selector)</text></svg>`;
  }

  function stackSvg() {
    const rnd = prng(11), muted = CHROME[mode()].tick;
    let s = svgOpen(360, 150);
    const names = ['TP10', 'AF8', 'AF7', 'TP9'];
    names.forEach((name, k) => {
      const base = 28 + k * 30, pts = [];
      for (let i = 0; i <= 80; i++) pts.push([60 + i * 3.5, base + (rnd() - 0.5) * 14]);
      s += `<path d="${pathOf(pts)}" fill="none" stroke="${col(SENSOR_HUE[name])}" stroke-width="1.3"/><text x="52" y="${base + 4}" text-anchor="end" fill="currentColor" font-weight="600">${name}</text>`;
    });
    s += `<line x1="350" y1="28" x2="350" y2="58" stroke="${muted}" marker-end="url(#ar)"/><path d="M346 32 L350 28 L354 32 M346 54 L350 58 L354 54" fill="none" stroke="${muted}"/>`;
    s += `<text x="345" y="46" text-anchor="end" fill="currentColor" font-size="10">offset</text>`;
    s += `<text x="60" y="144" fill="currentColor" font-size="10">each trace is centred on its own median, then shifted up by a fixed offset</text>`;
    return s + '</svg>';
  }

  function eventsSvg() {
    const rnd = prng(5), muted = CHROME[mode()].tick, neutral = CHROME[mode()].neutral;
    let s = svgOpen(360, 120);
    const pts = [];
    for (let i = 0; i <= 100; i++) { let y = 100 - rnd() * 6; if (i > 30 && i < 34) y -= (34 - Math.abs(32 - i) * 2) * 6; if (i > 70 && i < 73) y -= 24; pts.push([20 + i * 2.8, y]); }
    s += `<path d="${pathOf(pts)}" fill="none" stroke="${neutral}" stroke-width="1.2"/>`;
    for (const x of [26, 34, 41, 55, 60, 63, 82, 90, 96, 121, 128, 150, 161, 165, 188, 209, 214, 231, 260, 268, 280, 291]) s += `<line x1="${x}" y1="58" x2="${x}" y2="72" stroke="${col(EVENT_HUE.blink)}" stroke-width="1.5"/>`;
    for (const x of [109, 220]) s += `<line x1="${x}" y1="22" x2="${x}" y2="40" stroke="${col(EVENT_HUE.jaw)}" stroke-width="3"/>`;
    s += `<text x="310" y="34" fill="currentColor" font-size="10">jaw clench</text><text x="310" y="68" fill="currentColor" font-size="10">blink</text><text x="310" y="100" fill="currentColor" font-size="10">movement |Δg|</text>`;
    s += `<line x1="20" y1="104" x2="300" y2="104" stroke="${muted}" opacity="0.5"/>`;
    return s + '</svg>';
  }

  function ppgSvg() {
    const pts = [], muted = CHROME[mode()].tick;
    for (let i = 0; i <= 160; i++) { const t = i / 160, ph = (t * 4.5) % 1; const beat = Math.exp(-Math.pow((ph - 0.2) / 0.06, 2)) * 34 + Math.exp(-Math.pow((ph - 0.45) / 0.12, 2)) * 12; pts.push([20 + t * 320, 70 - beat]); }
    let s = svgOpen(360, 100) + `<path d="${pathOf(pts)}" fill="none" stroke="${col('red')}" stroke-width="2"/>`;
    const peaks = [0.2, 1.2, 2.2, 3.2, 4.2].map(v => 20 + (v / 4.5) * 320);
    for (const x of peaks) s += `<line x1="${x}" y1="30" x2="${x}" y2="80" stroke="${muted}" stroke-dasharray="2 3"/>`;
    s += `<path d="M${peaks[1]} 24 L${peaks[2]} 24" stroke="${muted}"/><text x="${(peaks[1] + peaks[2]) / 2}" y="18" text-anchor="middle" fill="currentColor" font-size="10">beat-to-beat interval → bpm</text>`;
    s += `<text x="20" y="94" fill="currentColor" font-size="10">pulse seen by the optical sensor as blood volume changes under the skin</text>`;
    return s + '</svg>';
  }

  function hsiSvg() {
    const status = { good: '#0ca30c', medium: '#fab219', poor: '#d03b3b' };
    const segs = [['TP9', 'M70 120 A60 62 0 0 1 84 60', 'good'], ['AF7', 'M90 54 A60 62 0 0 1 130 40', 'good'], ['AF8', 'M150 40 A60 62 0 0 1 190 54', 'medium'], ['TP10', 'M196 60 A60 62 0 0 1 210 120', 'poor']];
    let s = svgOpen(360, 140) + '<g transform="translate(40 0)">';
    for (const [name, d, q] of segs) s += `<path d="${d}" fill="none" stroke="${status[q]}" stroke-width="12" stroke-linecap="round"/>`;
    s += `<text x="60" y="136" text-anchor="middle" fill="currentColor" font-weight="600">TP9</text><text x="106" y="30" text-anchor="middle" fill="currentColor" font-weight="600">AF7</text><text x="174" y="30" text-anchor="middle" fill="currentColor" font-weight="600">AF8</text><text x="220" y="136" text-anchor="middle" fill="currentColor" font-weight="600">TP10</text>`;
    s += '</g>';
    [['good (1)', 'good'], ['medium (2)', 'medium'], ['poor (4)', 'poor']].forEach(([label, q], i) => { const y = 60 + i * 22; s += `<rect x="286" y="${y - 9}" width="12" height="12" rx="3" fill="${status[q]}"/><text x="304" y="${y + 1}" fill="currentColor">${label}</text>`; });
    return s + '</svg>';
  }

  function axesSvg() {
    const muted = CHROME[mode()].tick;
    let s = svgOpen(360, 150) + '<g transform="translate(90 0)">';
    s += `<ellipse cx="90" cy="78" rx="52" ry="58" fill="none" stroke="${muted}" stroke-width="1.5"/><path d="M82 22 Q90 8 98 22" fill="none" stroke="${muted}" stroke-width="1.5"/>`;
    const arrow = (x1, y1, x2, y2, c, label, lx, ly) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="2.5"/><circle cx="${x2}" cy="${y2}" r="3.5" fill="${c}"/><text x="${lx}" y="${ly}" fill="currentColor" font-weight="600">${label}</text>`;
    s += arrow(90, 78, 160, 78, col(XYZ_HUE[0]), 'X', 166, 82);
    s += arrow(90, 78, 90, 14, col(XYZ_HUE[1]), 'Y', 96, 14);
    s += `<circle cx="90" cy="78" r="9" fill="none" stroke="${col(XYZ_HUE[2])}" stroke-width="2.5"/><circle cx="90" cy="78" r="3" fill="${col(XYZ_HUE[2])}"/><text x="60" y="100" fill="currentColor" font-weight="600">Z</text>`;
    s += `<text x="90" y="146" text-anchor="middle" fill="currentColor" font-size="10">three axes fixed to the headband; Z points out of the page</text>`;
    return s + '</g></svg>';
  }

  function scaleSvg() {
    const muted = CHROME[mode()].tick, x = bel => 40 + (bel + 1.5) / 3 * 300;
    let s = svgOpen(360, 104);
    s += `<line x1="${x(-1.5)}" y1="50" x2="${x(1.5)}" y2="50" stroke="${muted}" stroke-width="1.5"/>`;
    for (const [bel, uv] of [[-1, '0.1 µV²'], [-0.5, '0.3'], [0, '1 µV²'], [0.5, '3'], [1, '10 µV²']]) {
      s += `<line x1="${x(bel)}" y1="44" x2="${x(bel)}" y2="56" stroke="${muted}"/>`;
      s += `<text x="${x(bel)}" y="36" text-anchor="middle" fill="currentColor" font-weight="600">${bel > 0 ? '+' : ''}${bel}</text>`;
      s += `<text x="${x(bel)}" y="72" text-anchor="middle" fill="currentColor" font-size="10">${uv}</text>`;
    }
    s += `<text x="${x(-1.5)}" y="16" fill="currentColor" font-size="10">axis value (Bels)</text><text x="${x(1.5)}" y="16" text-anchor="end" fill="currentColor" font-size="10">+1 = ×10 power · +0.3 ≈ ×2</text>`;
    s += `<text x="${x(-1.5)}" y="96" fill="currentColor" font-size="10">band power the value stands for</text>`;
    return s + '</svg>';
  }

  const scaleTips = () => ({ tips: [
    'The unit is Bels: log10 of the band’s power in µV². 0 means 1 µV², +1 means 10 µV², −1 means 0.1 µV². Every +0.3 is roughly a doubling of power.',
    'So the 0 line is a fixed physical reference, not your personal baseline. Each row auto-fits its own range, which is why 0 can sit anywhere in a row or be out of view.',
    'Read a band against its own level: the dashed line is that band’s session median, also printed under the band name. A move of 0.3 above the median is about twice the band’s usual power; 1 above it is ten times.',
    'Bands naturally sit at different heights: delta and theta are usually highest, gamma lowest (often around −1). That ordering is normal on its own; what matters is when a band moves relative to its own median.',
    'Typical Muse values lie between about −1 and +1.5. A band pinned high or swinging wildly usually means poor contact or muscle artefact; check Sensor contact and Events & movement.',
  ] });

  function relativeSvg() {
    const muted = CHROME[mode()].tick, rnd = prng(3), c = col('aqua');
    let s = svgOpen(360, 130);
    const y0 = 70, step = 18; // one doubling = 18 px
    const rows = [[2, '×4'], [1, '×2'], [0, 'baseline'], [-1, '÷2'], [-2, '÷4']];
    for (const [k, label] of rows) { const y = y0 - k * step; s += `<line x1="64" y1="${y}" x2="340" y2="${y}" stroke="${muted}" stroke-width="${k === 0 ? 1.5 : 0.8}" ${k === 0 ? 'stroke-dasharray="4 4"' : 'opacity="0.5"'}/><text x="58" y="${y + 4}" text-anchor="end" fill="currentColor" font-size="10">${label}</text>`; }
    const pts = [];
    for (let i = 0; i <= 60; i++) { const t = i / 60; const bel = 0.55 * Math.sin(t * 5.5) * Math.exp(-t) + 0.35 * Math.sin(t * 2.2 + 2) + (rnd() - 0.5) * 0.12; pts.push([64 + t * 276, y0 - (bel / LOG2) * step]); }
    s += `<path d="${pathOf(pts)}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
    s += `<text x="64" y="124" fill="currentColor" font-size="10">each gridline = one doubling of power (0.3 Bel) · dashed = the band's own baseline</text>`;
    return s + '</svg>';
  }

  const relativeTips = () => ({ tips: [
    'Each band is redrawn as its distance from its own baseline, so the dashed 0 line is that band’s normal level for this session and all bands share one scale.',
    'Because the data are log power, a fixed distance means a fixed multiplication: +0.3 Bel above the baseline is twice the band’s baseline power, +0.6 is four times, +1 is ten times; the same steps below mean ÷2, ÷4, ÷10. The axis is labelled in those multiples and the legend shows both the Bel change and the multiple.',
    'Baseline choices: the session median (robust; half the session sits above it, half below) or the mean of the first 1, 2 or 5 minutes. Use the first minutes when the session began with a deliberate resting baseline, but remember they often include settling in and poorer contact.',
    'It is good for seeing which bands moved the most and when, and for comparing bands that live at very different absolute levels, such as gamma and delta. It changes only the band-power charts; the raw data, the heatmap and the table stay absolute.',
  ] });

  function indicesSvg() {
    const muted = CHROME[mode()].tick, rnd = prng(19);
    const relC = col('aqua'), focC = col('violet');
    const y0 = 80, step = 20, yOf = d => y0 - d * step; // one step = one doubling
    let s = svgOpen(360, 172);
    for (const [d, label] of [[2, '\u00d74'], [1, '\u00d72'], [0, '1:1'], [-1, '\u00f72'], [-2, '\u00f74']]) {
      const y = yOf(d);
      s += `<line x1="56" y1="${y}" x2="288" y2="${y}" stroke="${muted}" stroke-width="${d === 0 ? 1.4 : 0.8}" ${d === 0 ? 'stroke-dasharray="4 4"' : 'opacity="0.4"'}/>`;
      s += `<text x="50" y="${y + 4}" text-anchor="end" fill="currentColor" font-size="10">${label}</text>`;
    }
    const rel = [], foc = [];
    for (let i = 0; i <= 46; i++) {
      const t = i / 46, x = 56 + t * 232;
      rel.push([x, yOf(0.95 + 0.3 * Math.sin(t * 5.0) + (rnd() - 0.5) * 0.4)]);
      foc.push([x, yOf(-0.5 + 0.28 * Math.sin(t * 3.4 + 1.6) + (rnd() - 0.5) * 0.4)]);
    }
    s += `<path d="${pathOf(rel)}" fill="none" stroke="${relC}" stroke-width="2" stroke-linejoin="round"/>`;
    s += `<path d="${pathOf(foc)}" fill="none" stroke="${focC}" stroke-width="2" stroke-linejoin="round"/>`;
    s += `<text x="294" y="${rel[rel.length - 1][1] + 4}" fill="currentColor" font-size="10">relaxation</text>`;
    s += `<text x="294" y="${foc[foc.length - 1][1] + 4}" fill="currentColor" font-size="10">focus</text>`;
    const gx = 150, ry = rel[Math.round(46 * (gx - 56) / 232)][1], fy = foc[Math.round(46 * (gx - 56) / 232)][1];
    s += `<line x1="${gx}" y1="${ry + 4}" x2="${gx}" y2="${fy - 4}" stroke="${muted}" stroke-width="1.2"/>`;
    s += `<path d="M${gx - 3} ${ry + 8} L${gx} ${ry + 3} L${gx + 3} ${ry + 8} M${gx - 3} ${fy - 8} L${gx} ${fy - 3} L${gx + 3} ${fy - 8}" fill="none" stroke="${muted}" stroke-width="1.2"/>`;
    s += `<text x="${gx + 7}" y="${(ry + fy) / 2 + 3}" fill="currentColor" font-size="10">gap</text>`;
    s += `<text x="56" y="164" fill="currentColor" font-size="10">gap between the lines = alpha \u00f7 beta (theta cancels out)</text>`;
    return s + '</svg>';
  }

  const bandList = () => ({ list: [
    ['Delta', 'Delta 1–4 Hz — dominant in deep sleep; large slow waves, also eye-movement artefacts'],
    ['Theta', 'Theta 4–8 Hz — drowsiness, light sleep, deep meditation'],
    ['Alpha', 'Alpha 7.5–13 Hz — relaxed wakefulness, strongest with eyes closed'],
    ['Beta', 'Beta 13–30 Hz — alert, active thinking and concentration'],
    ['Gamma', 'Gamma 30–44 Hz — higher-level processing; easily contaminated by muscle activity'],
  ].map(([b, t]) => [col(BAND_HUE[b]), t]) });
  const sensorList = () => ({ list: [
    ['TP9', 'TP9 — left side, behind the ear (temporal)'],
    ['AF7', 'AF7 — left forehead (frontal)'],
    ['AF8', 'AF8 — right forehead (frontal)'],
    ['TP10', 'TP10 — right side, behind the ear (temporal)'],
  ].map(([sn, t]) => [col(SENSOR_HUE[sn]), t]) });

  const HELP = {
    bands: () => ({ title: 'Band powers over time', graphic: bandsSvg() + scaleSvg(), body: [
      'Mind Monitor splits the EEG signal of each electrode into five frequency bands and logs, for every sample, the absolute power in each band as log10 of the power in µV² (Bels). This chart averages the four electrodes and smooths the result with a moving average, so slow shifts in the balance between bands stand out instead of second-to-second noise.',
      bandList(),
      'How to read the scale:',
      scaleTips(),
      'Spikes that line up with blinks, jaw clenches or movement (see Events & movement) are usually artefacts, not brain activity.',
      'Tip: the “Relative to baseline” toggle in the toolbar redraws every band as change from its own level, labelled in ×2 / ÷2 steps; its “?” explains the details.',
    ] }),
    relative: () => ({ title: 'Relative-to-baseline view', graphic: relativeSvg(), body: [
      'Turn on “Relative to baseline” to see change instead of level. It applies to “Band powers over time”, the per-band detail and the by-electrode chart.',
      relativeTips(),
      'Reading example: if alpha sits on the dashed line for most of the session and climbs to the ×2 gridline while your eyes are closed, alpha power doubled compared with its usual level in this session.',
    ] }),
    indices: () => ({ title: 'Relaxation and focus indices', graphic: indicesSvg(), body: [
      'Two ratios that Mind Monitor users often quote, computed from the electrode-averaged band powers: relaxation is alpha divided by theta, focus is beta divided by theta. Mind Monitor stores log power, so each ratio is exactly 10 to the power of the difference between the two bands. These are exact values, not estimates.',
      'Read both lines, as a pair. They are not two scores to choose between. Both are divided by theta, so where each line sits matters, and so does where they sit relative to each other.',
      { tips: [
        'Each line against the dashed 1:1 mark. Above it, that band has more power than theta; at the ×2 gridline, twice as much. Follow the shape over time rather than fixating on the number.',
        'The vertical gap between the two lines is alpha divided by beta, because the shared theta cancels out. A wide gap with relaxation on top is the calm, eyes-closed pattern. The lines crossing, so focus sits on top, is the alert, engaged pattern.',
        'When both lines move the same way at the same moment, it is theta that moved, not alpha or beta. Both dipping together usually means theta rose, from drowsiness or a burst of blinks, so check Events & movement before reading anything into it.',
        'Which line to watch depends on what you were doing. For meditation or winding down, follow relaxation. For concentration, follow focus; its inverse, theta divided by beta, is the classic attention marker, where a high value suggests inattention.',
      ] },
      'A worked example: relaxation at 2 and focus at 0.8 means alpha holds twice the power of theta while beta holds a little less than theta, and alpha holds about two and a half times the power of beta. That is a calm, settled stretch. If relaxation then falls to 1 while focus climbs to 1.5, the balance has tipped towards alert engagement.',
      { tips: [
        'These are heuristics, not diagnoses. Absolute levels differ between people and between headband fits, so compare within a session rather than across days.',
        'Artefacts move both lines. Blinks and eye movement inflate theta, which drags both indices down; jaw clenches and muscle tension inflate beta, which lifts focus on its own.',
        'The indices follow the toolbar smoothing setting and are unaffected by the relative-to-baseline toggle, because a ratio already carries its own reference at 1:1.',
      ] },
    ] }),
    'band-detail': () => ({ title: 'Band powers — per band detail', graphic: scaleSvg() + smoothingSvg(), body: [
      'The same electrode-averaged band powers as the chart above, drawn one band per row. Each row has its own vertical scale, so a small change in a quiet band (gamma, for example) is as visible as a large change in a busy one. The thin line is the value of every sample; the thick line is the moving average chosen in the toolbar; the dashed line is that band’s session median.',
      'How to read the scale:',
      scaleTips(),
      bandList(),
    ] }),
    'by-electrode': () => ({ title: 'Band power by electrode', graphic: headSvg(), body: [
      'The power of one band (chosen in the dropdown) on each of the four Muse electrodes, smoothed with the toolbar setting. The reference electrode sits at Fpz in the middle of the forehead.',
      sensorList(),
      'Compare left against right (TP9 vs TP10, AF7 vs AF8) for asymmetry, and front against back (AF7/AF8 vs TP9/TP10). Forehead electrodes usually show less alpha than the temporal ones because alpha is generated mainly towards the back of the head. When lines suddenly converge or jump, check Sensor contact and Events & movement: poor contact and movement affect single electrodes first.',
      'The vertical axis is in Bels (log10 of power in µV²): 0 is 1 µV², +1 is ten times more, and a gap of 0.3 between two electrodes means one has about twice the power of the other.',
    ] }),
    hr: () => ({ title: 'Heart rate', graphic: ppgSvg(), body: [
      'Heart rate in beats per minute, estimated by Mind Monitor from the optical (PPG) sensors on the forehead pad of the Muse S. The sensor shines light into the skin and measures how much returns; every heartbeat changes the blood volume and therefore the reflected light, and the interval between beats gives the rate.',
      'The area is filled to make level changes easy to see and the title shows the session mean. Samples where the file has 0 (no reading) are left as gaps.',
    ] }),
    heat: () => ({ title: 'Session band averages', graphic: headSvg(), body: [
      'One number per band and electrode: the mean log power over the whole session, in Bels. It is the same data as the band-power charts, collapsed into a single value per cell.',
      'Read a row to compare electrodes for one band, or a column to compare bands on one electrode. Cell colour follows the bar underneath: lighter cells are higher within this session. Because the values are logarithmic, a difference of 1 Bel is a tenfold difference in power.',
      sensorList(),
    ] }),
    events: () => ({ title: 'Events & movement', graphic: eventsSvg(), body: [
      'Ticks mark the moments Mind Monitor flagged an event in the Elements column: short ticks in the lower lane are blinks, tall ticks in the upper lane are jaw clenches. The counts are in the legend; click a legend entry to hide that lane.',
      'The grey trace is head movement: the size of the change in the accelerometer vector between two consecutive samples, in g. Holding still gives a value near zero; a nod, turn or fidget gives a spike.',
      'Blinks, jaw clenches and movement produce large electrical artefacts in EEG, so band-power peaks that coincide with them are usually not brain activity. Turn on “Mark blinks & jaw clenches on every chart” in the toolbar to see the events on top of every other chart.',
    ] }),
    raw: () => ({ title: 'Raw EEG, stacked by electrode', graphic: stackSvg(), body: [
      'The unprocessed EEG voltage on each electrode in microvolts, exactly as logged by Mind Monitor. To show the four electrodes together each trace is centred on its own median and shifted up by a fixed offset, so the vertical position only tells you which electrode it is; the legend shows the real microvolt value under the cursor.',
      'Mind Monitor records raw values between 0 and about 1682 µV, centred near 840 µV. A trace pinned near one of those limits, or a wildly jumping trace, means the electrode was not making contact. At the default one-sample-per-second export the raw column is a single sample per second, so it shows contact and artefacts rather than the waveform itself; a “constant” (256 Hz) export shows the actual signal.',
      sensorList(),
    ] }),
    hsi: () => ({ title: 'Sensor contact (horseshoe indicator)', graphic: hsiSvg(), body: [
      'Mind Monitor’s contact-quality score for each electrode, logged with every sample: 1 is good, 2 is medium and 4 is poor. It is the same information as the horseshoe symbol shown in the app.',
      'EEG band powers from an electrode with medium or poor contact are unreliable, so use these strips to decide which parts of the session and which electrodes to trust. The summary tile at the top shows the share of samples with good contact per electrode.',
    ] }),
    headband: () => ({ title: 'Headband on', graphic: '', body: ['1 while the headband reports that it is being worn and 0 when it is off the head. Data recorded while it is off is not brain activity.'] }),
    battery: () => ({ title: 'Battery', graphic: '', body: ['The headband battery level in percent, as reported to Mind Monitor during the session.'] }),
    col: () => ({ title: 'Other column', graphic: '', body: ['A numeric column in the file that this viewer does not recognise as a standard Mind Monitor field. It is charted exactly as logged so nothing in the file is hidden.'] }),
  };

  function helpKey(id) { if (!id) return null; if (HELP[id]) return id; const base = id.split('-')[0]; return HELP[base] ? base : null; }

  function openHelp(id) {
    const key = helpKey(id); if (!key) return;
    const h = HELP[key]();
    const dlg = $('help-dialog');
    $('help-title').textContent = h.title;
    $('help-graphic').innerHTML = h.graphic || '';
    const body = $('help-body'); body.textContent = '';
    for (const item of h.body) {
      if (typeof item === 'string') body.append(el('p', null, item));
      else if (item.list) { const ul = el('ul'); for (const [color, text] of item.list) { const li = el('li'); const k = el('span', 'key'); k.style.background = color; li.append(k, document.createTextNode(text)); ul.append(li); } body.append(ul); }
      else if (item.tips) { const ul = el('ul', 'tips'); for (const text of item.tips) ul.append(el('li', null, text)); body.append(ul); }
    }
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('help-close').focus();
  }

  function helpButton(id) {
    if (!helpKey(id)) return null;
    const b = el('button', 'help-btn', '?');
    b.type = 'button'; b.title = 'What is this chart?'; b.setAttribute('aria-label', 'What is this chart?');
    b.addEventListener('click', () => openHelp(id));
    return b;
  }

  // ---------- PNG export ----------
  // Exports re-render every chart offscreen at a fixed width, so the image has the same size and
  // proportions whether it was requested from a phone in portrait or a wide desktop window.
  const EXPORT_W = 1200;           // CSS px of content width inside the image
  const EXPORT_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const EXPORT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  function exportTheme() {
    return mode() === 'dark'
      ? { page: '#0d0d0d', surface: '#1a1a19', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781', border: 'rgba(255,255,255,0.12)' }
      : { page: '#f9f9f7', surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', border: 'rgba(11,11,11,0.12)' };
  }
  function wrapText(ctx, text, maxW) {
    const words = String(text).split(/\s+/), lines = [];
    let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    return lines;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function chartFor(plotEl) { return plotEl ? charts.find(c => c.el === plotEl) || null : null; }
  function seriesColor(u, i) { const s = u.series[i]; return s._stroke || (typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke); }
  function drawPlot(ctx, u, x, y) { ctx.drawImage(u.ctx.canvas, x, y, u.width, u.height); }

  // Offscreen copy of a live chart at a fixed width, keeping its zoom range and hidden series.
  async function renderTemp(spec, liveU, width, height) {
    const host = el('div');
    host.style.cssText = `position:absolute;left:-100000px;top:0;width:${width}px;pointer-events:none;`;
    document.body.append(host);
    const opts = makeOptions({ ...spec, height }, width);
    opts.legend = { show: false };
    opts.cursor = { show: false };
    opts.hooks.setScale = []; opts.hooks.setSelect = [];
    liveU.series.forEach((s, i) => { if (i > 0 && opts.series[i]) opts.series[i].show = s.show !== false; });
    const temp = { spec, el: host, full: { x: session.tmin, ys: spec.series.map(s => s.data) }, viewKey: null, staticView: null };
    const { min, max } = liveU.scales.x;
    const v = buildView(temp, min, max);
    const u = new uPlot(opts, v.data, host);
    u._chart = temp; temp.u = u;
    spec.series.forEach((s, i) => { if (s.kind) u.series[i + 1]._kind = s.kind; });
    u.setScale('x', { min, max });
    await new Promise(r => setTimeout(r, 0));
    return { u, destroy: () => { u.destroy(); host.remove(); } };
  }

  // Everything needed to paint one card, with offscreen charts already rendered at the export width.
  async function cardModel(card, width) {
    const pad = 16, contentW = width - 2 * pad;
    const model = { width, title: card.querySelector('h3')?.textContent || '', subtitle: card.querySelector('.chart-head .sub')?.textContent || '', temps: [] };
    const strips = card.querySelectorAll('.strip');
    const note = card.querySelector('.empty-note');
    if (strips.length) {
      model.strips = [];
      for (const st of strips) {
        const live = chartFor(st.querySelector('.chart-plot')); if (!live) continue;
        const spec = live.spec;
        const t = await renderTemp(spec, live.u, contentW - 104, spec.height || 140);
        model.temps.push(t);
        model.strips.push({ name: spec.label || '', lines: [spec.sub, spec.sub2].filter(Boolean), keyColor: spec.color, u: t.u });
      }
    } else if (card._heat) model.heat = card._heat;
    else if (note) model.note = note.textContent;
    else {
      const live = chartFor(card.querySelector('.chart-plot'));
      if (live) { const t = await renderTemp(live.spec, live.u, contentW, live.spec.height || 220); model.temps.push(t); model.u = t.u; }
    }
    return model;
  }

  // Paints one card model at (x, y) and returns its height. With dry=true it only measures.
  function paintCard(ctx, m, x, y, dry) {
    const T = exportTheme(), pad = 16, w = m.width, innerW = w - 2 * pad;
    let cy = y + pad;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = `600 16px ${EXPORT_FONT}`;
    const titleLines = wrapText(ctx, m.title, innerW);
    if (!dry) { ctx.fillStyle = T.ink; titleLines.forEach((l, i) => ctx.fillText(l, x + pad, cy + i * 22)); }
    cy += titleLines.length * 22;
    if (m.subtitle) {
      ctx.font = `12px ${EXPORT_FONT}`;
      const lines = wrapText(ctx, m.subtitle, innerW);
      if (!dry) { ctx.fillStyle = T.muted; lines.forEach((l, i) => ctx.fillText(l, x + pad, cy + 2 + i * 17)); }
      cy += lines.length * 17 + 4;
    }
    cy += 8;
    if (m.strips) {
      for (const st of m.strips) {
        const u = st.u;
        if (!dry) {
          const mid = cy + u.height / 2;
          if (st.keyColor) { ctx.fillStyle = st.keyColor; ctx.fillRect(x + pad, mid - 14, 14, 3); }
          ctx.fillStyle = T.ink; ctx.font = `600 13px ${EXPORT_FONT}`; ctx.fillText(st.name, x + pad + (st.keyColor ? 20 : 0), mid - 22);
          ctx.fillStyle = T.muted; ctx.font = `11px ${EXPORT_MONO}`; st.lines.forEach((l, i) => ctx.fillText(l, x + pad, mid - 2 + i * 14));
          drawPlot(ctx, u, x + pad + 104, cy);
        }
        cy += u.height + 2;
      }
    } else if (m.heat) {
      cy += paintHeatmap(ctx, m.heat, x + pad, cy, innerW, dry);
    } else if (m.note) {
      ctx.font = `13px ${EXPORT_FONT}`;
      const lines = wrapText(ctx, m.note, innerW);
      if (!dry) { ctx.fillStyle = T.muted; lines.forEach((l, i) => ctx.fillText(l, x + pad, cy + i * 18)); }
      cy += lines.length * 18;
    } else if (m.u) {
      const u = m.u;
      if (!dry) drawPlot(ctx, u, x + pad, cy);
      cy += u.height + 8;
      ctx.font = `12px ${EXPORT_FONT}`;
      let lx = x + pad, ly = cy; const lineH = 18;
      let any = false;
      for (let i = 1; i < u.series.length; i++) {
        const s = u.series[i]; if (s.show === false) continue;
        const label = s.label || '', wLabel = ctx.measureText(label).width + 20 + 18;
        if (lx + wLabel > x + w - pad && lx > x + pad) { lx = x + pad; ly += lineH; }
        if (!dry) { ctx.fillStyle = seriesColor(u, i); ctx.fillRect(lx, ly + 7, 14, 3); ctx.fillStyle = T.ink2; ctx.fillText(label, lx + 20, ly); }
        lx += wLabel; any = true;
      }
      if (any) cy = ly + lineH;
    }
    cy += pad;
    return cy - y;
  }

  function paintHeatmap(ctx, heat, x, y, w, dry) {
    const T = exportTheme(), { bands, sensors, vals, min, max } = heat, span = max - min || 1;
    const rowH = 40, gap = 3, labelW = 60, colW = (w - labelW - gap * (sensors.length - 1)) / sensors.length;
    let cy = y;
    if (!dry) { ctx.font = `12px ${EXPORT_FONT}`; ctx.fillStyle = T.ink2; ctx.textAlign = 'center'; sensors.forEach((sn, c) => ctx.fillText(sn, x + labelW + c * (colW + gap) + colW / 2, cy)); ctx.textAlign = 'left'; }
    cy += 20;
    bands.forEach((band, r) => {
      if (!dry) { ctx.fillStyle = T.ink2; ctx.font = `12px ${EXPORT_FONT}`; ctx.textAlign = 'right'; ctx.fillText(band, x + labelW - 8, cy + rowH / 2 - 7); ctx.textAlign = 'left'; }
      sensors.forEach((sn, c) => {
        const v = vals[r][c], cx = x + labelW + c * (colW + gap);
        if (dry) return;
        const bg = v === v ? rampColor((v - min) / span) : T.surface;
        roundRect(ctx, cx, cy, colW, rowH, 4); ctx.fillStyle = bg; ctx.fill();
        ctx.fillStyle = v === v ? (luminance(bg) > 0.4 ? '#0b0b0b' : '#ffffff') : T.muted;
        ctx.font = `13px ${EXPORT_MONO}`; ctx.textAlign = 'center'; ctx.fillText(fmtSigned(v), cx + colW / 2, cy + rowH / 2 - 7); ctx.textAlign = 'left';
      });
      cy += rowH + gap;
    });
    cy += 8;
    if (!dry) {
      ctx.font = `12px ${EXPORT_MONO}`; ctx.fillStyle = T.muted;
      ctx.fillText(fmtSigned(min), x, cy);
      const barX = x + 56, barW = Math.min(240, w - 200);
      const g = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      CHROME[mode()].ramp.forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
      roundRect(ctx, barX, cy + 4, barW, 8, 4); ctx.fillStyle = g; ctx.fill();
      ctx.fillStyle = T.muted; ctx.fillText(fmtSigned(max) + '   mean log-power (Bels)', barX + barW + 10, cy);
    }
    cy += 20;
    return cy - y;
  }

  function paintPanel(ctx, m, x, y) {
    const T = exportTheme();
    const h = paintCard(ctx, m, x, y, true);
    roundRect(ctx, x, y, m.width, h, 12); ctx.fillStyle = T.surface; ctx.fill(); ctx.strokeStyle = T.border; ctx.lineWidth = 1; ctx.stroke();
    paintCard(ctx, m, x, y, false);
    return h;
  }

  function exportFooter() {
    const parts = [`Source: ${session.fileName || 'Mind Monitor CSV'}`, `exported ${fmtDateTime(Date.now() / 1000, false)}`];
    const ref = charts[0];
    if (ref) { const d = ref.u.data[0], { min, max } = ref.u.scales.x; if (d.length && (min !== d[0] || max !== d[d.length - 1])) parts.push(`showing ${min.toFixed(2)}–${max.toFixed(2)} min`); }
    parts.push('MindMonitor EEG Viewer · mmmcharts.pages.dev');
    return parts.join('  ·  ');
  }

  // items: [{heading}] or [{cards:[...]}]; cards in one item are laid out two per row.
  async function composeImage(items, withHeader) {
    const T = exportTheme(), W = EXPORT_W, margin = 20, gap = 14;
    const rows = [];
    for (const it of items) {
      if (it.heading) { rows.push({ heading: it.heading }); continue; }
      const cards = it.cards;
      for (let i = 0; i < cards.length; i += 2) {
        const pair = cards.slice(i, i + 2);
        const cw = pair.length === 2 ? Math.floor((W - gap) / 2) : W;
        rows.push({ models: await Promise.all(pair.map(c => cardModel(c, cw))) });
      }
    }
    const measure = document.createElement('canvas').getContext('2d');
    const layout = ctx => {
      const drawing = ctx !== measure;
      let y = margin;
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      if (withHeader) {
        if (drawing) { ctx.fillStyle = T.ink; ctx.font = `300 26px ${EXPORT_FONT}`; ctx.fillText('EEG Recording', margin, y); ctx.fillStyle = T.muted; ctx.font = `12px ${EXPORT_MONO}`; ctx.fillText($('session-sub').textContent, margin, y + 34); }
        y += 60;
      }
      for (const row of rows) {
        if (row.heading) {
          if (drawing) { ctx.fillStyle = T.ink2; ctx.font = `600 13px ${EXPORT_FONT}`; ctx.fillText(row.heading.toUpperCase(), margin, y + 10); }
          y += 34;
          continue;
        }
        let x = margin, rowH = 0;
        for (const m of row.models) { const h = drawing ? paintPanel(ctx, m, x, y) : paintCard(measure, m, x, y, true); rowH = Math.max(rowH, h); x += m.width + gap; }
        y += rowH + gap;
      }
      ctx.font = `11px ${EXPORT_FONT}`;
      const footerLines = wrapText(ctx, exportFooter(), W);
      if (drawing) { ctx.fillStyle = T.muted; footerLines.forEach((l, i) => ctx.fillText(l, margin, y + 2 + i * 15)); }
      y += footerLines.length * 15 + 4 + margin;
      return y;
    };
    try {
      const H = layout(measure);
      const totalW = W + 2 * margin;
      const S = Math.max(1, Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (totalW * H)), 3));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(totalW * S); canvas.height = Math.round(H * S);
      const ctx = canvas.getContext('2d');
      ctx.scale(S, S);
      ctx.fillStyle = T.page; ctx.fillRect(0, 0, totalW, H);
      layout(ctx);
      return canvas;
    } finally {
      for (const row of rows) if (row.models) for (const m of row.models) for (const t of m.temps) t.destroy();
    }
  }

  function downloadCanvas(canvas, name) {
    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }, 'image/png');
  }
  function exportBaseName() { return (session.fileName || 'mindmonitor').replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_'); }
  function exportSuffix() { return (smoothSec ? `_${smoothSec}s` : '_raw') + (relativeMode ? '_rel' : ''); } // smoothing and view used for the export

  async function withBusy(btn, fn) {
    const label = btn && btn.textContent; if (btn) { btn.disabled = true; if (!btn.classList.contains('help-btn')) btn.textContent = 'Preparing…'; }
    try { await fn(); } catch (e) { console.error(e); alert('Sorry, the image could not be created.'); }
    finally { if (btn) { btn.disabled = false; if (!btn.classList.contains('help-btn')) btn.textContent = label; } }
  }

  function exportCard(card, btn) {
    if (!session || !card) return;
    return withBusy(btn, async () => {
      const canvas = await composeImage([{ cards: [card] }], false);
      downloadCanvas(canvas, `${exportBaseName()}_${card.dataset.exportId || 'chart'}${exportSuffix()}.png`);
    });
  }

  function dashboardItems() {
    const items = [];
    const walk = root => {
      for (const node of root.children) {
        if (node.matches('h2')) items.push({ heading: node.textContent });
        else if (node.matches('.card')) items.push({ cards: [node] });
        else if (node.matches('.chart-grid')) items.push({ cards: [...node.querySelectorAll(':scope > .card')] });
        else if (node.matches('details.more') && node.open) walk(node.querySelector('.more-body'));
      }
    };
    walk($('panel-charts'));
    return items;
  }

  function exportDashboard(btn) {
    if (!session) return;
    return withBusy(btn, async () => {
      const canvas = await composeImage(dashboardItems(), true);
      downloadCanvas(canvas, `${exportBaseName()}_charts${exportSuffix()}.png`);
    });
  }

  function downloadButton() {
    const b = el('button', 'help-btn dl-btn');
    b.type = 'button'; b.title = 'Download this chart as a PNG image'; b.setAttribute('aria-label', 'Download this chart as a PNG image');
    b.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.addEventListener('click', () => exportCard(b.closest('.card'), b));
    return b;
  }

  // ---------- rendering ----------
  function chartHead(title, subtitle, extra, helpId) {
    const head = el('header', 'chart-head');
    const left = el('div', 'head-left');
    left.append(el('h3', null, title));
    const hb = helpButton(helpId); if (hb) left.append(hb);
    left.append(downloadButton());
    if (extra) left.append(extra);
    head.append(left);
    if (subtitle) head.append(el('p', 'sub', subtitle));
    return head;
  }

  function renderBlocks(container, blocks) {
    const pending = [];
    renderBlockList(container, blocks, pending);
    for (const [spec, plot] of pending) createChart(spec, plot); // create once the whole layout is in the DOM so widths are final
    resizeCharts();
  }

  function renderBlockList(container, blocks, pending) {
    for (const b of blocks) {
      if (b.type === 'section') container.append(el('h2', null, b.title));
      else if (b.type === 'bmc') { const src = document.querySelector('.topbar .bmc'); if (src) { const wrap = el('div', 'bmc-inline'); wrap.append(src.cloneNode(true)); container.append(wrap); } }
      else if (b.type === 'grid2') { const g = el('div', 'chart-grid cols-2'); container.append(g); renderBlockList(g, b.items, pending); }
      else if (b.type === 'note') { const card = el('section', 'card'); card.dataset.exportId = b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'); card.append(chartHead(b.title)); card.append(el('p', 'empty-note', b.text)); container.append(card); }
      else if (b.type === 'chart') {
        const spec = b.spec, card = el('section', 'card');
        card.dataset.exportId = spec.id;
        let extra = null;
        if (spec.bandSelect) {
          extra = el('label'); extra.append('band');
          const sel = document.createElement('select');
          for (const o of spec.bandSelect.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === spec.bandSelect.value) op.selected = true; sel.append(op); }
          sel.addEventListener('change', () => {
            electrodeBand = sel.value;
            const chart = charts.find(c => c.spec.id === 'by-electrode');
            if (!chart) return;
            const next = electrodeSpec(electrodeBand);
            card.querySelector('h3').textContent = next.title;
            replaceChart(chart, next); // only this chart is rebuilt, so the page does not scroll
          });
          extra.append(sel);
        }
        card.append(chartHead(spec.title, spec.subtitle, extra, spec.id));
        const plot = el('div', 'chart-plot'); card.append(plot); container.append(card);
        pending.push([spec, plot]);
      }
      else if (b.type === 'strips') {
        const card = el('section', 'card');
        card.dataset.exportId = b.id;
        card.append(chartHead(b.title, b.subtitle, null, b.id));
        const wrap = el('div', 'strips'); card.append(wrap); container.append(card);
        for (const st of b.strips) {
          const row = el('div', 'strip');
          const lab = el('div', 'strip-label');
          const name = el('b'); const key = el('span', 'key'); key.style.background = st.color; name.append(key, st.label); lab.append(name);
          if (st.sub) lab.append(el('span', 'strip-readout', st.sub));
          if (st.sub2) lab.append(el('span', 'strip-readout', st.sub2));
          const readout = el('span', 'strip-readout'); lab.append(readout);
          const plot = el('div', 'chart-plot strip-plot');
          row.append(lab, plot); wrap.append(row);
          const last = st.series.length;
          st.onCursor = u => {
            const i = u.cursor.idx;
            const y = u.data[last];
            readout.textContent = (i == null || y == null || y[i] == null) ? '' : `${u.series[last].value(u, y[i], last, i)} · ${u.data[0][i].toFixed(2)} min`;
          };
          pending.push([st, plot]);
        }
      }
      else if (b.type === 'heatmap') container.append(heatmapCard(b));
    }
  }

  function heatmapCard(b) {
    const s = session, card = el('section', 'card');
    card.dataset.exportId = b.id;
    card.append(chartHead(b.title, b.subtitle, null, b.id));
    const bands = s.bandsPresent, sensors = s.sensorsPresent;
    const vals = bands.map(band => sensors.map(sn => { const x = s.bandCols[band].find(x => x.sn === sn); return x ? x.col.mean : NaN; }));
    const flat = vals.flat().filter(v => v === v);
    const min = Math.min(...flat), max = Math.max(...flat), span = max - min || 1;
    card._heat = { bands, sensors, vals, min, max };
    const grid = el('div', 'heatmap');
    grid.style.gridTemplateColumns = `auto repeat(${sensors.length}, 1fr)`;
    grid.append(el('div', 'hm-corner'));
    for (const sn of sensors) grid.append(el('div', 'hm-col', sn));
    bands.forEach((band, r) => {
      grid.append(el('div', 'hm-row', band));
      sensors.forEach((sn, c) => {
        const v = vals[r][c], cell = el('div', 'hm-cell', fmtSigned(v));
        if (v === v) { const bg = rampColor((v - min) / span); cell.style.background = bg; cell.style.color = luminance(bg) > 0.4 ? '#0b0b0b' : '#ffffff'; }
        else cell.style.background = 'var(--surface-2)';
        cell.title = `${band} · ${sn}: ${fmtNum(v, 4)}`;
        grid.append(cell);
      });
    });
    card.append(grid);
    const leg = el('div', 'hm-legend');
    const bar = el('span', 'bar'); bar.style.background = `linear-gradient(90deg, ${CHROME[mode()].ramp.join(', ')})`;
    leg.append(el('span', null, fmtSigned(min)), bar, el('span', null, fmtSigned(max)), el('span', null, 'mean log-power (Bels)'));
    card.append(leg);
    return card;
  }

  function renderSummary(s, file) {
    const t0 = s.t0, t1 = s.times[s.rows - 1], dur = t1 - t0;
    const parts = [s.device || 'Muse headband', fmtDateTime(t0, false).slice(0, 16), `${(dur / 60).toFixed(1)} min`, `${fmtInt(s.rows)} samples`, `${fmtInt(s.eventIndex.blink.length)} blinks`, `${fmtInt(s.eventIndex.jaw.length)} jaw clenches`];
    $('session-sub').textContent = parts.join('  ·  ');

    const box = $('summary'); box.textContent = '';
    const tile = (label, value, unit, sub) => {
      const d = el('div', 'tile');
      d.append(el('p', 'label', label));
      const v = el('div', 'value'); v.textContent = value; if (unit) v.append(el('small', null, unit)); d.append(v);
      if (sub) d.append(el('p', 'sub', sub));
      box.append(d);
    };
    const iv = s.interval;
    tile('Sample interval', isFinite(iv) ? (iv >= 1 ? iv.toFixed(2) + ' s' : (iv * 1000).toFixed(0) + ' ms') : '—', '', isFinite(iv) ? `≈ ${fmtNum(1 / iv, 3)} Hz · ${fmtInt(s.rows)} data rows` : '');
    if (hasData(s.battery)) tile('Battery', `${fmtNum(firstValid(s.battery.data), 3)} → ${fmtNum(lastValid(s.battery.data), 3)}`, '%', 'start → end');
    if (hasData(s.headband)) { let on = 0; for (let i = 0; i < s.rows; i++) if (s.headband.data[i] === 1) on++; tile('Headband on', fmtNum(100 * on / s.rows, 3), '%', 'of data rows'); }
    if (s.hsi.length) {
      const pct = s.hsi.map(x => { let g = 0; for (let i = 0; i < s.rows; i++) if (x.col.data[i] === 1) g++; return { name: x.sn, p: 100 * g / x.col.count }; });
      const avg = pct.reduce((a, x) => a + x.p, 0) / pct.length;
      tile('Good sensor contact', fmtNum(avg, 3), '%', pct.map(x => `${x.name} ${Math.round(x.p)}`).join(' · ') + ' (% of samples)');
    }
    if (s.hr && s.hr.count) tile('Heart rate', Math.round(s.hr.mean), 'bpm', `mean over ${fmtInt(s.hr.count)} readings`);
    tile('File', fmtBytes(file.size), '', `${fmtInt(s.headers.length)} columns · ${fmtInt(s.totalLines)} lines${s.badLines ? ` · ${fmtInt(s.badLines)} skipped` : ''}`);
  }
  function firstValid(a) { for (let i = 0; i < a.length; i++) if (a[i] === a[i]) return a[i]; return NaN; }
  function lastValid(a) { for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return a[i]; return NaN; }

  function renderCharts() {
    destroyCharts();
    const panel = $('panel-charts'); panel.textContent = '';
    renderBlocks(panel, mainBlocks());
    const det = el('details', 'more');
    const sum = el('summary'); sum.append('More signals'); sum.append(' '); sum.append(el('span', 'muted', '— sensor contact, headband, battery'));
    const body = el('div', 'more-body');
    det.append(sum, body); panel.append(det);
    let built = false;
    const build = () => {
      if (built) return; built = true;
      const before = charts.length;
      renderBlocks(body, moreBlocks());
      const ref = charts[0];
      if (ref && charts.length > before) { const { min, max } = ref.u.scales.x; for (let i = before; i < charts.length; i++) charts[i].u.setScale('x', { min, max }); }
    };
    det.addEventListener('toggle', () => { moreOpen = det.open; if (det.open) build(); });
    if (moreOpen) { det.open = true; build(); }
  }

  function rerender() {
    if (!session) return;
    const y = window.scrollY;
    renderCharts();
    window.scrollTo(0, y);
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  function destroyCharts() { for (const c of charts) c.u.destroy(); charts = []; }

  function resizeCharts() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      for (const c of charts) { const w = Math.max(200, c.el.clientWidth); if (w !== c.u.width) c.u.setSize({ width: w, height: c.spec.height || 220 }); }
    });
  }

  function resetZoom() {
    for (const c of charts) { const d = c.u.data[0]; if (d.length) c.u.setScale('x', { min: d[0], max: d[d.length - 1] }); }
  }

  // ---------- table view ----------
  const PAGE = 50;
  let page = 0;
  function renderTable(s) {
    const panel = $('panel-table'); panel.textContent = '';
    const statsSec = el('div', 'table-section');
    statsSec.append(el('h2', null, 'Column summary'));
    const wrap = el('div', 'table-wrap'), tbl = el('table');
    const thead = el('thead'), hr = el('tr');
    for (const h of ['Column', 'Values', 'Min', 'Max', 'Mean', 'Non-zero']) { const th = el('th', h === 'Column' ? '' : 'num', h); th.scope = 'col'; hr.append(th); }
    thead.append(hr); tbl.append(thead);
    const tb = el('tbody');
    for (const c of s.columns) {
      const tr = el('tr');
      tr.append(el('td', null, c.name), el('td', 'num', fmtInt(c.count)), el('td', 'num', fmtNum(c.min, 6)), el('td', 'num', fmtNum(c.max, 6)), el('td', 'num', fmtNum(c.mean, 6)), el('td', 'num', fmtInt(c.nonzero)));
      tb.append(tr);
    }
    tbl.append(tb); wrap.append(tbl); statsSec.append(wrap); panel.append(statsSec);

    if (s.events.length) {
      const evSec = el('div', 'table-section');
      evSec.append(el('h2', null, `Events (${fmtInt(s.events.length)})`));
      const w2 = el('div', 'table-wrap'), t2 = el('table');
      const th2 = el('thead'), r2 = el('tr');
      for (const h of ['#', 'Time', 'Minutes', 'Element']) { const th = el('th', h === '#' || h === 'Minutes' ? 'num' : '', h); th.scope = 'col'; r2.append(th); }
      th2.append(r2); t2.append(th2);
      const b2 = el('tbody');
      const limit = Math.min(s.events.length, 2000);
      for (let i = 0; i < limit; i++) { const tr = el('tr'); tr.append(el('td', 'num', String(i + 1)), el('td', null, fmtDateTime(s.events[i].t)), el('td', 'num', ((s.events[i].t - s.t0) / 60).toFixed(3)), el('td', null, s.events[i].text)); b2.append(tr); }
      t2.append(b2); w2.append(t2); evSec.append(w2);
      if (s.events.length > limit) evSec.append(el('p', 'muted', `Showing the first ${fmtInt(limit)} events.`));
      panel.append(evSec);
    }

    const rowsSec = el('div', 'table-section');
    rowsSec.append(el('h2', null, 'Data rows'));
    const pager = el('div', 'pager');
    const prev = el('button', 'btn', 'Previous'), next = el('button', 'btn', 'Next');
    const info = el('span'); const jump = document.createElement('input'); jump.type = 'number'; jump.min = 1; jump.setAttribute('aria-label', 'Go to page');
    pager.append(prev, next, info, el('span', null, 'Go to page'), jump);
    const w3 = el('div', 'table-wrap'), t3 = el('table');
    const th3 = el('thead'), r3 = el('tr');
    { const th = el('th', 'num', '#'); th.scope = 'col'; r3.append(th); }
    { const th = el('th', '', s.tsName); th.scope = 'col'; r3.append(th); }
    for (const c of s.columns) { const th = el('th', 'num', c.name); th.scope = 'col'; r3.append(th); }
    th3.append(r3); t3.append(th3);
    const b3 = el('tbody'); t3.append(b3); w3.append(t3);
    rowsSec.append(pager, w3); panel.append(rowsSec);
    const pages = Math.max(1, Math.ceil(s.rows / PAGE));
    const draw = () => {
      page = Math.min(Math.max(0, page), pages - 1);
      b3.textContent = '';
      const start = page * PAGE, end = Math.min(s.rows, start + PAGE);
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const tr = el('tr');
        tr.append(el('td', 'num', fmtInt(i + 1)), el('td', null, fmtDateTime(s.times[i])));
        for (const c of s.columns) { const v = c.data[i]; tr.append(el('td', 'num', v === v ? fmtNum(v, 7) : '')); }
        frag.append(tr);
      }
      b3.append(frag);
      info.textContent = `Rows ${fmtInt(start + 1)}–${fmtInt(end)} of ${fmtInt(s.rows)} · page ${page + 1} of ${fmtInt(pages)}`;
      prev.disabled = page === 0; next.disabled = page >= pages - 1; jump.max = pages; jump.value = page + 1;
    };
    prev.onclick = () => { page--; draw(); };
    next.onclick = () => { page++; draw(); };
    jump.onchange = () => { page = (parseInt(jump.value, 10) || 1) - 1; draw(); };
    page = 0; draw();
  }

  // ---------- file loading ----------
  async function loadFile(file, isSample = false) {
    const status = $('load-status'), bar = $('progress-bar'), txt = $('load-text'), err = $('load-error');
    err.hidden = true; status.hidden = false; bar.style.width = '2%'; txt.textContent = `Reading ${file.name} (${fmtBytes(file.size)})…`;
    await yieldToUI();
    try {
      if (!/\.csv$/i.test(file.name) && !/csv/i.test(file.type)) throw new Error('Please choose a .csv file exported by Mind Monitor.');
      const text = await file.text();
      txt.textContent = 'Parsing…';
      const s = await parseCsv(text, p => { bar.style.width = (2 + 96 * p).toFixed(1) + '%'; txt.textContent = `Parsing… ${Math.round(100 * p)}%`; });
      if (s.rows === 0) throw new Error(s.badLines ? 'No rows with a readable timestamp were found.' : 'The file has a header but no data rows.');
      prepareSession(s);
      smoothCache.clear();
      session = s;
      txt.textContent = 'Building charts…'; bar.style.width = '100%';
      await yieldToUI();
      s.isSample = isSample;
      showResults(s, file);
    } catch (e) {
      console.error(e);
      err.textContent = 'Could not load this file: ' + (e && e.message ? e.message : e);
      err.hidden = false;
    } finally {
      status.hidden = true; bar.style.width = '0';
    }
  }

  const SAMPLE_URL = 'sample/sample-session.csv';

  // Fetches the demo recording shipped with the site and runs it through the normal load path.
  async function loadSample(btn) {
    const status = $('load-status'), bar = $('progress-bar'), txt = $('load-text'), err = $('load-error');
    if (btn) btn.disabled = true;
    err.hidden = true; status.hidden = false; bar.style.width = '4%'; txt.textContent = 'Fetching the sample session…';
    try {
      const res = await fetch(SAMPLE_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`the server returned ${res.status}`);
      const text = await res.text();
      bar.style.width = '8%';
      await loadFile(new File([text], 'sample-session.csv', { type: 'text/csv' }), true);
    } catch (e) {
      console.error(e);
      status.hidden = true; bar.style.width = '0';
      err.textContent = 'Could not load the sample session: ' + (e && e.message ? e.message : e);
      err.hidden = false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function showResults(s, file) {
    $('upload-view').hidden = true;
    $('results-view').hidden = false;
    const chip = $('file-chip'); chip.textContent = s.isSample ? 'Sample session' : file.name; chip.hidden = false;
    $('btn-new-file').hidden = false;
    s.fileName = file.name;
    renderSummary(s, file);
    renderCharts();
    renderTable(s);
    selectTab('charts');
    document.title = `${file.name} — MindMonitor EEG Viewer`;
  }

  function showUpload() {
    destroyCharts(); session = null; smoothCache.clear();
    $('results-view').hidden = true; $('upload-view').hidden = false;
    $('file-chip').hidden = true; $('btn-new-file').hidden = true;
    $('file-input').value = '';
    document.title = 'MindMonitor EEG Viewer';
    window.scrollTo(0, 0);
  }

  function selectTab(name) {
    for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.tab === name; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    $('panel-charts').hidden = name !== 'charts';
    $('panel-table').hidden = name !== 'table';
    if (name === 'charts') resizeCharts();
  }

  // ---------- wiring ----------
  const drop = $('dropzone'), input = $('file-input');
  input.addEventListener('change', () => { if (input.files && input.files[0]) loadFile(input.files[0]); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  for (const evName of ['dragenter', 'dragover']) drop.addEventListener(evName, e => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const evName of ['dragleave', 'drop']) drop.addEventListener(evName, e => { e.preventDefault(); drop.classList.remove('is-over'); });
  drop.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f && $('results-view').hidden === false) { showUpload(); loadFile(f); } });

  $('btn-new-file').addEventListener('click', showUpload);
  $('btn-sample').addEventListener('click', e => loadSample(e.currentTarget));
  $('help-close').addEventListener('click', () => $('help-dialog').close());
  $('help-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('btn-reset-zoom').addEventListener('click', resetZoom);
  // The dashboard download first shows a short support prompt; "Proceed to download" runs the export.
  $('btn-download').addEventListener('click', () => {
    const dlg = $('support-dialog'), slot = $('support-bmc');
    if (!slot.childElementCount) { const src = document.querySelector('.topbar .bmc'); if (src) slot.append(src.cloneNode(true)); }
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('support-proceed').focus();
  });
  $('support-proceed').addEventListener('click', () => { $('support-dialog').close(); exportDashboard($('btn-download')); });
  $('support-close').addEventListener('click', () => $('support-dialog').close());
  $('support-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('chk-events').addEventListener('change', e => { showEvents = e.target.checked; for (const c of charts) c.u.redraw(false); });
  $('sel-smooth').addEventListener('change', e => { smoothSec = Number(e.target.value) || 0; rerender(); });
  $('chk-relative').addEventListener('change', e => { relativeMode = e.target.checked; $('sel-baseline').disabled = !relativeMode; rerender(); });
  $('sel-baseline').addEventListener('change', e => { baselineMode = e.target.value; if (relativeMode) rerender(); });
  $('btn-relative-help').addEventListener('click', () => openHelp('relative'));
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  window.addEventListener('resize', resizeCharts);
  if ('ResizeObserver' in window) new ResizeObserver(() => resizeCharts()).observe($('panel-charts'));
  darkMq.addEventListener('change', rerender);

  // Exposed for automated testing (loads a CSV from a string; inspects chart state).
  window.__mmLoadText = (text, name = 'session.csv') => loadFile(new File([text], name, { type: 'text/csv' }));
  window.__mmDebug = { charts: () => charts, session: () => session, renderCard: card => composeImage([{ cards: [card] }], false), renderDashboard: () => composeImage(dashboardItems(), true) };
})();
