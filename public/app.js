/* global Chart */
const $ = (sel) => document.querySelector(sel);

const VARS = {
  temperature: { label: 'Temperature', unit: '°C', digits: 1 },
  humidity: { label: 'Humidity', unit: '%', digits: 0 },
  pressure: { label: 'Pressure', unit: 'hPa', digits: 1 },
  windSpeed: { label: 'Wind', unit: 'km/h', digits: 1 },
};

const STORAGE_KEY = 'weather-prediction:last-place';
const charts = {};
let place = null;
let data = null;
let detailVar = 'humidity';
let leadVar = 'temperature';

/* ---------- formatting ---------- */

const fmt = (v, digits = 1) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(digits));
const pct = (v) => `${Math.round(v * 100)}%`;

function hourLabel(t, opts = {}) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: place.timezone, ...opts }).format(t);
}

function localHour(t) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: place.timezone }).format(t));
}

function weekday(t) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: place.timezone }).format(t);
}

function relativeTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

function dateRange(from, to) {
  const f = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: place.timezone });
  return `${f.format(from)} and ${f.format(to)}`;
}

/* ---------- view state ---------- */

function show(id) {
  for (const s of ['empty', 'loading', 'error', 'result']) $(`#${s}`).hidden = s !== id;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  return {
    ink: cssVar('--ink'),
    muted: cssVar('--muted'),
    rule: cssVar('--rule'),
    model: cssVar('--model'),
    band80: cssVar('--band80'),
    band95: cssVar('--band95'),
    rain: cssVar('--rain'),
    nwp: cssVar('--nwp'),
    obs: cssVar('--obs'),
    font: cssVar('--font'),
  };
}

/* ---------- search ---------- */

const input = $('#city');
const list = $('#city-options');
let options = [];
let active = -1;
let searchTimer = null;
let searchSeq = 0;

function placeLabel(p) {
  return [p.admin1, p.country].filter(Boolean).join(', ');
}

function renderOptions() {
  list.replaceChildren(
    ...options.map((p, i) => {
      const li = document.createElement('li');
      li.id = `opt-${i}`;
      li.role = 'option';
      li.setAttribute('aria-selected', String(i === active));
      li.innerHTML = '<div class="name"></div><div class="sub"></div>';
      li.querySelector('.name').textContent = p.name;
      li.querySelector('.sub').textContent = placeLabel(p);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(p);
      });
      return li;
    }),
  );
  const open = options.length > 0;
  list.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
  else input.removeAttribute('aria-activedescendant');
}

function closeOptions() {
  options = [];
  active = -1;
  renderOptions();
}

async function search(q) {
  const seq = ++searchSeq;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    if (seq !== searchSeq) return;
    options = body.results ?? [];
    active = options.length ? 0 : -1;
    renderOptions();
  } catch {
    if (seq === searchSeq) closeOptions();
  }
}

input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) return closeOptions();
  searchTimer = setTimeout(() => search(q), 220);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && options.length) {
    active = (active + 1) % options.length;
    renderOptions();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' && options.length) {
    active = (active - 1 + options.length) % options.length;
    renderOptions();
    e.preventDefault();
  } else if (e.key === 'Enter' && active >= 0) {
    choose(options[active]);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeOptions();
  }
});

input.addEventListener('blur', () => setTimeout(closeOptions, 100));

function choose(p) {
  closeOptions();
  input.value = '';
  input.blur();
  load({
    name: p.name,
    region: placeLabel(p),
    latitude: p.latitude,
    longitude: p.longitude,
    timezone: p.timezone || 'UTC',
  });
}

document.querySelectorAll('.quick button').forEach((b) => {
  b.addEventListener('click', () =>
    load({
      name: b.dataset.name,
      region: b.dataset.country,
      latitude: Number(b.dataset.lat),
      longitude: Number(b.dataset.lon),
      timezone: b.dataset.tz,
    }),
  );
});

$('#retry').addEventListener('click', () => place && load(place));

/* ---------- loading ---------- */

function saveLocation(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: nothing to remember */
  }
  const url = new URL(location.href);
  url.search = new URLSearchParams({
    lat: p.latitude.toFixed(3),
    lon: p.longitude.toFixed(3),
    name: p.name,
    region: p.region ?? '',
    tz: p.timezone,
  }).toString();
  history.replaceState(null, '', url);
}

function initialPlace() {
  const q = new URLSearchParams(location.search);
  if (q.has('lat') && q.has('lon')) {
    return {
      name: q.get('name') || `${q.get('lat')}, ${q.get('lon')}`,
      region: q.get('region') || '',
      latitude: Number(q.get('lat')),
      longitude: Number(q.get('lon')),
      timezone: q.get('tz') || 'UTC',
    };
  }
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

let loadSeq = 0;

async function load(p) {
  const seq = ++loadSeq;
  place = p;
  saveLocation(p);
  document.title = `${p.name} forecast`;
  $('#loading-text').textContent = `Loading the forecast for ${p.name}`;
  show('loading');
  try {
    const res = await fetch(`/api/forecast?lat=${p.latitude}&lon=${p.longitude}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The server responded with ${res.status}.`);
    if (seq !== loadSeq) return;
    data = body;
    show('result');
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    $('#error-text').textContent = `Couldn't load the forecast for ${p.name}. ${err.message}`;
    show('error');
  }
}

/* ---------- rendering ---------- */

function render() {
  renderNow();
  renderHours();
  renderFan();
  renderDetail();
  renderQuality();
}

function renderNow() {
  const obs = data.observed;
  const last = obs.times.length - 1;
  const fc = data.forecast;
  $('#place').textContent = place.region ? `${place.name}, ${place.region}` : place.name;
  $('#now-meta').textContent = `Forecast from ${hourLabel(data.origin, { minute: '2-digit' })} local time. Model trained ${relativeTime(data.model.trainedAt)}.`;
  $('#now-temp').textContent = Math.round(obs.temperature[last]);
  const temps = fc.temperature.mean;
  $('#range').textContent = `${Math.round(Math.min(...temps))}° to ${Math.round(Math.max(...temps))}°`;
  const peak = fc.rainProbability.reduce((best, p, i) => (p > fc.rainProbability[best] ? i : best), 0);
  $('#rain-peak').textContent = `${pct(fc.rainProbability[peak])} at ${hourLabel(data.times[peak])}`;
  $('#now-hum').textContent = `${Math.round(obs.humidity[last])}%`;
  $('#now-wind').textContent = `${Math.round(obs.windSpeed[last])} km/h`;
  $('#stale').hidden = !data.model.stale;
}

function renderHours() {
  const fc = data.forecast;
  const strip = $('#hour-strip');
  strip.replaceChildren(
    ...data.times.map((t, i) => {
      const el = document.createElement('div');
      el.className = 'hour';
      const midnight = localHour(t) === 0;
      if (midnight) el.classList.add('day-start');
      const p = fc.rainProbability[i];
      el.innerHTML = `
        <span class="h"></span>
        <span class="t"></span>
        <span class="bar" aria-hidden="true"><span></span></span>
        <span class="p"></span>
        <span class="w"></span>`;
      el.querySelector('.h').textContent = midnight ? weekday(t) : hourLabel(t);
      el.querySelector('.t').textContent = `${Math.round(fc.temperature.mean[i])}°`;
      el.querySelector('.bar span').style.height = `${Math.max(2, p * 100)}%`;
      el.querySelector('.p').textContent = pct(p);
      el.querySelector('.w').textContent = `${Math.round(fc.windSpeed.mean[i])} km/h`;
      el.setAttribute(
        'aria-label',
        `${hourLabel(t)}: ${fmt(fc.temperature.mean[i])} degrees, ${pct(p)} chance of rain, wind ${Math.round(fc.windSpeed.mean[i])} km/h`,
      );
      return el;
    }),
  );
}

// Draws a vertical "now" marker at the forecast origin.
const nowLine = {
  id: 'nowLine',
  afterDatasetsDraw(chart, _args, opts) {
    if (opts.index == null) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(opts.index);
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = opts.color;
    ctx.font = `500 12px ${opts.font}`;
    ctx.fillText('Now', x + 6, chartArea.top + 12);
    ctx.restore();
  },
};

function baseOptions(t, { unit, digits, yTitle } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: t.ink,
        titleColor: cssVar('--paper'),
        bodyColor: cssVar('--paper'),
        titleFont: { family: t.font, weight: '600' },
        bodyFont: { family: t.font },
        padding: 10,
        displayColors: false,
        filter: (item) => !item.dataset.band && item.raw != null,
        callbacks: {
          label: (item) => {
            const ds = item.dataset;
            let text = `${ds.label}: ${fmt(item.raw, digits)} ${unit}`;
            if (ds.range) {
              const [lo, hi] = ds.range;
              text += ` (80% range ${fmt(lo[item.dataIndex], digits)} to ${fmt(hi[item.dataIndex], digits)})`;
            }
            return text;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: t.rule },
        ticks: { color: t.muted, font: { family: t.font }, maxRotation: 0, autoSkipPadding: 18 },
      },
      y: {
        grid: { color: t.rule },
        border: { display: false },
        title: { display: Boolean(yTitle), text: yTitle, color: t.muted, font: { family: t.font } },
        ticks: { color: t.muted, font: { family: t.font } },
      },
    },
  };
}

function replaceChart(key, canvas, config) {
  charts[key]?.destroy();
  charts[key] = new Chart(canvas, config);
}

// Observed history followed by the forecast; the forecast series start at the last observation
// so the lines join up at "now".
function fanDatasets(name, t) {
  const obs = data.observed[name];
  const fc = data.forecast[name];
  const nwp = data.nwp[name];
  const pad = new Array(obs.length - 1).fill(null);
  const anchor = obs[obs.length - 1];
  const joined = (arr) => [...pad, anchor, ...arr];
  const band = (label, arr, fill, color) => ({
    label,
    data: joined(arr),
    band: true,
    borderWidth: 0,
    pointRadius: 0,
    fill,
    backgroundColor: color,
  });
  return [
    {
      label: 'Observed',
      data: [...obs, ...new Array(fc.mean.length).fill(null)],
      borderColor: t.obs,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
    },
    band('95% high', fc.hi95, false),
    band('95% low', fc.lo95, '-1', t.band95),
    band('80% high', fc.hi80, false),
    band('80% low', fc.lo80, '-1', t.band80),
    {
      label: 'Model',
      data: joined(fc.mean),
      range: [joined(fc.lo80), joined(fc.hi80)],
      borderColor: t.model,
      borderWidth: 3,
      pointRadius: 0,
      tension: 0.3,
    },
    {
      label: 'Open-Meteo',
      data: [...new Array(obs.length).fill(null), ...nwp],
      borderColor: t.nwp,
      borderWidth: 2,
      borderDash: [6, 5],
      pointRadius: 0,
      tension: 0.3,
    },
  ];
}

function allLabels() {
  return [...data.observed.times, ...data.times].map((t) => {
    const h = localHour(t);
    return h === 0 ? weekday(t) : hourLabel(t);
  });
}

function renderFan() {
  const t = theme();
  const opts = baseOptions(t, { unit: '°C', digits: 1 });
  opts.plugins.nowLine = { index: data.observed.times.length - 1, color: t.muted, font: t.font };
  opts.scales.y.ticks.callback = (v) => `${v}°`;
  replaceChart('fan', $('#fan-chart'), {
    type: 'line',
    data: { labels: allLabels(), datasets: fanDatasets('temperature', t) },
    options: opts,
    plugins: [nowLine],
  });
}

function renderDetail() {
  const t = theme();
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.var === detailVar));
  });
  const canvas = $('#detail-chart');
  if (detailVar === 'rain') {
    const opts = baseOptions(t, { unit: '%', digits: 0 });
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    opts.scales.y.ticks.callback = (v) => `${v}%`;
    const labels = data.times.map((x) => (localHour(x) === 0 ? weekday(x) : hourLabel(x)));
    replaceChart('detail', canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'bar',
            label: 'Model',
            data: data.forecast.rainProbability.map((p) => p * 100),
            backgroundColor: t.rain,
            borderRadius: 3,
            maxBarThickness: 18,
          },
          {
            type: 'line',
            label: 'Open-Meteo',
            data: data.nwp.precipitationProbability,
            borderColor: t.nwp,
            borderWidth: 2,
            borderDash: [6, 5],
            pointRadius: 0,
            tension: 0.3,
          },
        ],
      },
      options: opts,
    });
    return;
  }
  const v = VARS[detailVar];
  const opts = baseOptions(t, { unit: v.unit, digits: v.digits, yTitle: v.unit });
  opts.plugins.nowLine = { index: data.observed.times.length - 1, color: t.muted, font: t.font };
  replaceChart('detail', canvas, {
    type: 'line',
    data: { labels: allLabels(), datasets: fanDatasets(detailVar, t) },
    options: opts,
    plugins: [nowLine],
  });
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    detailVar = b.dataset.var;
    renderDetail();
  });
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('.tabs button')];
    const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
});

$('#lead-var').addEventListener('change', (e) => {
  leadVar = e.target.value;
  renderLead();
});

function signedPct(v) {
  const n = Math.round(v * 100);
  return `${n > 0 ? '+' : ''}${n}%`;
}

function renderQuality() {
  const m = data.metrics;
  $('#quality-lede').textContent =
    `Measured on ${m.origins} forecasts started between ${dateRange(m.from, m.to)}, a period the model never saw while training. ` +
    `“Same as now” assumes nothing changes over the next 24 hours, the simplest forecast there is.`;

  const rows = Object.entries(VARS).map(([name, v]) => {
    const vm = m.variables[name];
    const tr = document.createElement('tr');
    const skill = vm.skillVsPersistence;
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td class="order"></td>';
    const cells = tr.children;
    cells[0].textContent = v.label;
    cells[1].textContent = `±${fmt(vm.meanMae, v.digits === 0 ? 1 : v.digits)} ${v.unit}`;
    cells[2].textContent = signedPct(skill);
    cells[2].className = skill >= 0 ? 'pos' : 'neg';
    cells[3].textContent = pct(vm.coverage80);
    cells[4].textContent = data.model.variables[name].order;
    return tr;
  });
  const rain = m.rain;
  const rainRow = document.createElement('tr');
  rainRow.innerHTML = '<td>Rain chance</td><td></td><td></td><td>–</td><td class="order">Logistic regression</td>';
  rainRow.children[1].textContent = `Brier ${rain.brier.toFixed(3)}`;
  rainRow.children[2].textContent = `${signedPct(rain.brierSkill)} vs monthly average`;
  rainRow.children[2].className = rain.brierSkill >= 0 ? 'pos' : 'neg';
  $('#quality-rows').replaceChildren(...rows, rainRow);

  $('#rain-note').textContent =
    `Dots on the diagonal mean a 30% chance really rained about 30% of the time. Bigger dots stand for more forecast hours. ` +
    `A Brier score of ${rain.brier.toFixed(3)} compares with ${rain.brierClimatology.toFixed(3)} for always forecasting the usual rate for the month; lower is better.`;

  renderLead();
  renderReliability();
}

function renderLead() {
  const t = theme();
  const v = VARS[leadVar];
  const vm = data.metrics.variables[leadVar];
  const opts = baseOptions(t, { unit: v.unit, digits: 2, yTitle: `Average error, ${v.unit}` });
  opts.plugins.tooltip.callbacks.title = (items) => `${items[0].label} hours ahead`;
  opts.scales.x.title = { display: true, text: 'Hours ahead', color: t.muted, font: { family: t.font } };
  opts.scales.y.beginAtZero = true;
  const line = (label, values, color, extra = {}) => ({
    label,
    data: values,
    borderColor: color,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.25,
    ...extra,
  });
  replaceChart('lead', $('#lead-chart'), {
    type: 'line',
    data: {
      labels: vm.mae.map((_, i) => i + 1),
      datasets: [
        line('This model', vm.mae, t.model, { borderWidth: 3 }),
        line('Same as now', vm.maePersistence, t.ink, { borderDash: [2, 4] }),
        line('Seasonal average', vm.maeClimatology, t.nwp, { borderDash: [6, 5] }),
      ],
    },
    options: {
      ...opts,
      plugins: {
        ...opts.plugins,
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: t.muted, font: { family: t.font }, boxWidth: 22, boxHeight: 0 },
        },
      },
    },
  });
}

function renderReliability() {
  const t = theme();
  const rel = data.metrics.rain.reliability;
  const maxN = Math.max(...rel.map((r) => r.n));
  const opts = baseOptions(t, { unit: '%', digits: 0 });
  opts.interaction = { mode: 'nearest', intersect: true };
  opts.scales.x = {
    ...opts.scales.x,
    type: 'linear',
    min: 0,
    max: 100,
    title: { display: true, text: 'Forecast chance', color: t.muted, font: { family: t.font } },
    ticks: { ...opts.scales.x.ticks, callback: (v) => `${v}%` },
  };
  opts.scales.y = {
    ...opts.scales.y,
    min: 0,
    max: 100,
    title: { display: true, text: 'How often it rained', color: t.muted, font: { family: t.font } },
    ticks: { ...opts.scales.y.ticks, callback: (v) => `${v}%` },
  };
  opts.plugins.tooltip.callbacks = {
    label: (item) =>
      item.raw.n
        ? `Forecast ${Math.round(item.raw.x)}%, rained ${Math.round(item.raw.y)}% of ${item.raw.n} hours`
        : '',
  };
  replaceChart('rel', $('#rel-chart'), {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Perfect',
          type: 'line',
          data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
          borderColor: t.rule,
          borderWidth: 2,
          pointRadius: 0,
          band: true,
        },
        {
          label: 'Model',
          data: rel.map((r) => ({ x: r.forecast * 100, y: r.observed * 100, n: r.n })),
          backgroundColor: t.rain,
          pointRadius: rel.map((r) => 3 + 9 * Math.sqrt(r.n / maxN)),
          pointHoverRadius: rel.map((r) => 4 + 9 * Math.sqrt(r.n / maxN)),
        },
      ],
    },
    options: opts,
  });
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => data && render());

/* ---------- start ---------- */

if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = theme().font;
}

const start = initialPlace();
if (start && Number.isFinite(start.latitude) && Number.isFinite(start.longitude)) load(start);
else show('empty');
