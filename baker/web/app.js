'use strict';

// Graphical front-end. Every action calls the same geometry baker used by
// the CLI (window.GeoBaker* modules); there is no canned texture data.
const { parseOBJ } = window.GeoBakerMesh;
const { bake } = window.GeoBakerBaker;
const { grayscaleToRGBA, statusToRGBA, maskToRGBA } = window.GeoBakerImage;
const { Renderer } = window.GeoBakerRender;
const { V } = window.GeoBakerMath;

const el = (id) => document.getElementById(id);
const state = { low: null, high: null, result: null, lowName: '', highName: '', layer: 'normal' };

el('outer').addEventListener('input', (e) => { el('outerVal').textContent = Number(e.target.value).toFixed(2); });
el('inner').addEventListener('input', (e) => { el('innerVal').textContent = Number(e.target.value).toFixed(2); });

function setStatus(msg, kind) {
  const s = el('status');
  s.textContent = msg;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

async function handleMesh(input, which) {
  const file = input.files[0];
  if (!file) return;
  try {
    const text = await readFileText(file);
    const mesh = parseOBJ(text, file.name);
    if (which === 'low') {
      if (!mesh.uvFaces.length) throw new Error('低模缺少 UV，无法烘焙');
      state.low = mesh; state.lowName = file.name;
      el('lowInfo').textContent = `${mesh.faces.length} 三角面 · ${mesh.partNames.length} 部件 · 含 UV`;
    } else {
      state.high = mesh; state.highName = file.name;
      el('highInfo').textContent = `${mesh.faces.length} 三角面 · ${mesh.partNames.length} 部件`;
    }
    el('bakeBtn').disabled = !(state.low && state.high);
    setStatus('模型已载入，可调整笼体后烘焙', 'ok');
  } catch (e) {
    setStatus('载入失败：' + e.message, 'err');
  }
}
el('lowFile').addEventListener('change', (e) => handleMesh(e.target, 'low'));
el('highFile').addEventListener('change', (e) => handleMesh(e.target, 'high'));

el('loadDemo').addEventListener('click', () => {
  const scene = el('demoScene').value;
  const data = window.GeoBakerDemo[scene]();
  state.low = parseOBJ(data.low, scene + '_low');
  state.high = parseOBJ(data.high, scene + '_high');
  state.lowName = scene + '_low.obj';
  state.highName = scene + '_high.obj';
  el('lowInfo').textContent = `内置 · ${state.low.faces.length} 三角面 · ${state.low.partNames.length} 部件`;
  el('highInfo').textContent = `内置 · ${state.high.faces.length} 三角面 · ${state.high.partNames.length} 部件`;
  el('bakeBtn').disabled = false;
  setStatus('内置场景已载入，点击烘焙', 'ok');
});

function currentConfig() {
  return {
    lowPath: state.lowName,
    highPath: state.highName,
    size: Number(el('size').value),
    outerDistance: Number(el('outer').value),
    innerDistance: Number(el('inner').value),
    policy: el('policy').value,
  };
}

el('bakeBtn').addEventListener('click', () => {
  if (!state.low || !state.high) return;
  setStatus('烘焙中：构建 BVH、逐纹素投射…', 'work');
  // Defer so the status paints before the synchronous bake blocks the UI.
  setTimeout(() => {
    try {
      const cfg = currentConfig();
      const t0 = performance.now();
      state.result = bake(state.low, state.high, {
        size: cfg.size,
        outerDistance: cfg.outerDistance,
        innerDistance: cfg.innerDistance,
        policy: cfg.policy,
      });
      state.result.elapsedMs = performance.now() - t0;
      state.config = cfg;
      showMetrics();
      selectLayer(state.layer);
      el('saveConfig').disabled = false;
      setStatus(`烘焙完成（${state.result.elapsedMs.toFixed(0)} ms），可切换诊断层查看投射偏差`, 'ok');
    } catch (e) {
      setStatus('烘焙失败：' + e.message, 'err');
    }
  }, 30);
});

function showMetrics() {
  const r = state.result;
  el('metrics').classList.remove('hidden');
  const covered = r.size * r.size - r.counts.outside_uv - r.counts.degenerate;
  const protectedCount = r.layers.protectedMask.reduce((n, v) => n + (v ? 1 : 0), 0);
  el('mHit').textContent = r.counts.hit;
  el('mConflict').textContent = r.counts.conflict;
  el('mMiss').textContent = r.counts.miss;
  el('mProtected').textContent = protectedCount;
  el('mClean').textContent = (100 * r.counts.hit / covered).toFixed(1) + '%';
  el('mAny').textContent = (100 * (r.counts.hit + r.counts.conflict) / covered).toFixed(1) + '%';
}

function putRGBA(canvas, rgba, size) {
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
}

const LEGENDS = {
  status: [
    ['#28c878', '干净命中'], ['#e63c3c', '未命中'], ['#ffb400', '多候选冲突/跨部件'],
    ['#1e1e28', 'UV 外'], ['#b400dc', '退化 UV'],
  ],
  protected: [['#5aa0ff', '归属保护：拒绝了跨部件/背面候选'], ['#14141c', '无保护事件']],
};

function selectLayer(layer) {
  state.layer = layer;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.layer === layer));
  const tex = el('texCanvas'), rcanvas = el('renderCanvas'), dcanvas = el('debugCanvas');
  tex.classList.add('hidden'); rcanvas.classList.add('hidden'); dcanvas.classList.add('hidden');
  el('renderControls').classList.add('hidden');
  el('legend').innerHTML = '';
  if (!state.result) return;
  const r = state.result;
  const L = r.layers;

  if (layer === 'render') {
    rcanvas.classList.remove('hidden');
    el('renderControls').classList.remove('hidden');
    drawRender();
    el('layerCaption').textContent = '低模实时软件光栅渲染；勾选对照可关闭法线贴图，验证细节来自烘焙而非高模截图。';
    return;
  }
  if (layer === 'debug') {
    dcanvas.classList.remove('hidden');
    drawDebug();
    el('layerCaption').textContent = '俯视示意：蓝线为射线方向，灰框为笼体范围，绿点=采纳命中，红点=被拒候选，黄点=未命中射线末端。';
    return;
  }

  tex.classList.remove('hidden');
  if (layer === 'normal') {
    putRGBA(tex, L.normal, r.size);
    el('layerCaption').textContent = '切线空间法线（RGB 编码，+Z 蓝色为中性）。切线框架由低模 UV 梯度构建，高模法线经同一变换写入。';
  } else if (layer === 'distance') {
    putRGBA(tex, grayscaleToRGBA(L.distance, r.size), r.size);
    el('layerCaption').textContent = '显式支持的距离通道：命中点沿低模法线的位移绝对值（不是无符号射线深度）。';
  } else if (layer === 'signed') {
    putRGBA(tex, grayscaleToRGBA(L.signedDistance, r.size, {
      diverging: true, max: Math.max(1e-6, ...Array.from(L.signedDistance).map(Math.abs)),
    }), r.size);
    el('layerCaption').textContent = '带符号距离：暖色=高模表面在低模外侧，冷色=内凹（如凹槽）。';
  } else if (layer === 'status') {
    putRGBA(tex, statusToRGBA(L.status, r.size), r.size);
    el('layerCaption').textContent = '逐纹素诊断：未命中与多候选冲突被保留，不静默丢弃。';
  } else if (layer === 'protected') {
    putRGBA(tex, maskToRGBA(L.protectedMask, r.size, [90, 160, 255], [20, 20, 28]), r.size);
    el('layerCaption').textContent = '部件归属保护层：标记 ownership 策略成功阻止跨部件/背面穿透的纹素。';
  }
  if (LEGENDS[layer]) {
    el('legend').innerHTML = LEGENDS[layer].map(([c, t]) =>
      `<span class="key"><span class="swatch" style="background:${c}"></span>${t}</span>`).join('');
  }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectLayer(t.dataset.layer)));

function drawRender() {
  const low = state.low, r = state.result;
  const b = low.bounds();
  const span = V.sub(b.max, b.min);
  const dist = Math.max(...span) * 2.2;
  const ortho = Math.max(...span) * 0.75;
  const c = b.center;
  const eyes = {
    front: [c[0], c[1], c[2] + dist],
    side: [c[0] + dist, c[1], c[2]],
    top: [c[0], c[1] + dist, c[2] + 0.01],
    iso: [c[0] + dist * 0.7, c[1] + dist * 0.7, c[2] + dist * 0.7],
  };
  const eye = eyes[el('view').value];
  const light = V.norm(V.add(V.scale(V.sub(c, eye), 0.6), [0.3, 0.8, 0.4]));
  const renderer = new Renderer(384, 384);
  const opts = { light };
  if (!el('flatToggle').checked) opts.bake = r;
  renderer.render(low, renderer.makeView(eye, b.center, undefined, 35, ortho), opts);
  const canvas = el('renderCanvas');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(384, 384);
  img.data.set(renderer.color);
  ctx.putImageData(img, 0, 0);
}
['view', 'flatToggle'].forEach((id) => el(id).addEventListener('change', drawRender));

// Project a 3D point to a top-down 2D canvas using world X/Y for the debug view.
function drawDebug() {
  const r = state.result;
  const canvas = el('debugCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  ctx.fillStyle = '#0c0e13';
  ctx.fillRect(0, 0, W, W);
  const low = state.low;
  const b = low.bounds();
  const pad = 0.08;
  const toXY = (p) => [
    ((p[0] - b.min[0]) / (b.max[0] - b.min[0])) * (W - 40) + 20,
    W - (((p[1] - b.min[1]) / (b.max[1] - b.min[1])) * (W - 40) + 20),
  ];
  // Cage outline from the outer cage bounds.
  const cb = r.cage.outer.bounds();
  const [x0, y0] = toXY([cb.min[0], cb.min[1], 0]);
  const [x1, y1] = toXY([cb.max[0], cb.max[1], 0]);
  ctx.strokeStyle = '#5a6275'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.setLineDash([]);

  const step = Math.max(1, Math.floor(r.size / 28));
  for (const rec of r.records) {
    if (rec.px % step || rec.py % step) continue;
    const [ax, ay] = toXY(rec.rayOrigin);
    const [bx, by] = toXY(rec.cageOuter);
    ctx.strokeStyle = 'rgba(91,140,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    if (rec.chosen) {
      const [hx, hy] = toXY(rec.chosen.point);
      ctx.fillStyle = '#34d399';
      ctx.fillRect(hx - 2, hy - 2, 4, 4);
    } else {
      const [mx, my] = toXY(rec.cageOuter);
      ctx.fillStyle = '#f5b544';
      ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
    }
    for (const rej of rec.rejected) {
      const [rx, ry] = toXY(rej.point);
      ctx.fillStyle = '#ef5b5b';
      ctx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
    }
  }
}

el('saveConfig').addEventListener('click', () => {
  if (!state.config) return;
  const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bake-config.json'; a.click();
  URL.revokeObjectURL(url);
});

el('configFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const cfg = JSON.parse(await readFileText(file));
    if (cfg.size) el('size').value = String(cfg.size);
    if (cfg.outerDistance != null) { el('outer').value = cfg.outerDistance; el('outerVal').textContent = Number(cfg.outerDistance).toFixed(2); }
    if (cfg.innerDistance != null) { el('inner').value = cfg.innerDistance; el('innerVal').textContent = Number(cfg.innerDistance).toFixed(2); }
    if (cfg.policy) el('policy').value = cfg.policy;
    setStatus('配置已载入（仍需选择对应高低模文件）', 'ok');
  } catch (err) {
    setStatus('配置载入失败：' + err.message, 'err');
  }
});

el('exportPng').addEventListener('click', () => {
  const canvas = el('renderCanvas');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'low-render.png'; a.click();
});
