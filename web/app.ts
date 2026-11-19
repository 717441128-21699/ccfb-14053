// 岸上查看器:加载航次文件 → TVG 校正 → 海底检测 → 双频鱼群识别 → 渲染。
// 全部计算在浏览器内完成,一个航次(约 22 MB)打开到可看的耗时显示在页首。

import { decodeVoyage, type VoyageFile } from "../src/shared/format.js";
import { tvgColumn } from "../src/shared/acoustics.js";
import { detectBottom } from "../src/shared/bottom.js";
import { detectSchools, type School } from "../src/shared/schools.js";

interface IndexEntry {
  id: string; file: string; vessel: string; startTime: string;
  durationMin: number; pingCount: number; haulCount: number; sizeBytes: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- 色标:Sv dB → RGB(经典探鱼仪配色,暗底) ----------
function svColor(sv: number): [number, number, number] {
  // -100 dB 以下近黑,-30 dB 以上深红
  const t = Math.max(0, Math.min(1, (sv + 100) / 70));
  if (t < 0.2) { const u = t / 0.2; return [0, 0, Math.round(20 + 60 * u)]; } // 黑→深蓝
  if (t < 0.45) { const u = (t - 0.2) / 0.25; return [0, Math.round(90 * u), Math.round(80 + 100 * u)]; } // 蓝→青
  if (t < 0.65) { const u = (t - 0.45) / 0.2; return [0, Math.round(90 + 130 * u), Math.round(180 - 120 * u)]; } // 青→绿
  if (t < 0.82) { const u = (t - 0.65) / 0.17; return [Math.round(230 * u), 220, 0]; } // 绿→黄
  if (t < 0.93) { const u = (t - 0.82) / 0.11; return [230, Math.round(220 - 130 * u), 0]; } // 黄→橙
  const u = (t - 0.93) / 0.07;
  return [Math.round(230 - 40 * u), Math.round(90 - 50 * u), Math.round(20 * u)]; // 橙→红棕
}

interface Loaded {
  voyage: VoyageFile;
  sv: Float32Array[]; // 每通道 Sv
  bottom: Float32Array;
  schools: School[];
}

let current: Loaded | null = null;
let selectedSchool: number | null = null;

async function loadVoyage(entry: IndexEntry) {
  const t0 = performance.now();
  $("loadstat").textContent = `加载 ${entry.file} (${(entry.sizeBytes / 1e6).toFixed(1)} MB)…`;
  const buf = await (await fetch(`/data/${entry.file}`)).arrayBuffer();
  const tFetch = performance.now();
  const voyage = decodeVoyage(buf);
  const h = voyage.header;
  const P = h.pingCount, S = h.sampleCount;

  // TVG 校正 → Sv
  const sv = h.frequenciesHz.map((_, f) => {
    const tvg = tvgColumn(S, h.rangeCellSizeM, h.absorptionDbPerKm[f]);
    const raw = voyage.channels[f];
    const out = new Float32Array(P * S);
    for (let k = 0; k < raw.length; k++) out[k] = raw[k] / 100 - h.calibrationDb[f] + tvg[k % S];
    return out;
  });

  // 海底检测 + 鱼群识别
  const bottom = detectBottom(sv[0], {
    pingCount: P, sampleCount: S, cellSizeM: h.rangeCellSizeM,
  });
  const schools = detectSchools(sv[0], sv[1], bottom, h, voyage.speedKn);
  const tAnalysis = performance.now();

  current = { voyage, sv, bottom, schools };
  renderAll();
  const tRender = performance.now();
  $("loadstat").innerHTML =
    `打开耗时 <b>${((tRender - t0) / 1000).toFixed(2)} s</b>` +
    `(下载 ${((tFetch - t0) / 1000).toFixed(2)} s,分析 ${(tAnalysis - tFetch).toFixed(0)} ms,渲染 ${(tRender - tAnalysis).toFixed(0)} ms)`;
}

// ---------- 渲染 ----------
function renderAll() {
  if (!current) return;
  renderEchograms();
  renderStrip();
  renderMap();
  renderStats();
  renderSchoolTable();
}

function echoCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")!];
}

function renderEchograms() {
  const { voyage, sv } = current!;
  const h = voyage.header;
  const P = h.pingCount, S = h.sampleCount;
  const stack = $("echostack");
  stack.innerHTML = "";
  const viewH = 260;

  h.frequenciesHz.forEach((freq, f) => {
    const label = document.createElement("div");
    label.className = "echolabel";
    label.textContent = `${freq / 1000} kHz`;
    stack.appendChild(label);

    const box = document.createElement("div");
    box.style.position = "relative";
    box.style.width = `${P}px`;
    box.style.height = `${viewH}px`;

    // 回波图
    const [img, ctx] = echoCanvas(P, S);
    const data = ctx.createImageData(P, S);
    const px = data.data;
    const channel = sv[f];
    for (let k = 0; k < P * S; k++) {
      const [r, g, b] = svColor(channel[k]);
      const o = k * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    img.className = "echo";
    img.style.cssText = `position:absolute;left:0;top:0;width:${P}px;height:${viewH}px`;
    box.appendChild(img);

    // 矢量叠加层(海底线 / 目标框 / 网次标记 / 深度网格)
    const [ovl] = echoCanvas(P, viewH);
    ovl.style.cssText = `position:absolute;left:0;top:0;width:${P}px;height:${viewH}px`;
    ovl.dataset.channel = String(f);
    box.appendChild(ovl);
    stack.appendChild(box);

    box.addEventListener("mousemove", (ev) => showReadout(ev, box, viewH));
  });
  drawOverlays();
}

function yToSample(viewH: number, y: number, S: number) { return (y / viewH) * S; }
function sampleToY(viewH: number, s: number, S: number) { return (s / S) * viewH; }

function drawOverlays() {
  if (!current) return;
  const { voyage, bottom, schools } = current!;
  const h = voyage.header;
  const P = h.pingCount, S = h.sampleCount;
  const viewH = 260;
  const showBottom = ($("showBottom") as HTMLInputElement).checked;
  const showLayer = ($("showLayer") as HTMLInputElement).checked;
  const showSchools = ($("showSchools") as HTMLInputElement).checked;

  document.querySelectorAll<HTMLCanvasElement>("canvas[data-channel]").forEach((ovl, idx) => {
    const ctx = ovl.getContext("2d")!;
    ctx.clearRect(0, 0, P, viewH);
    // 深度网格(每 20 m)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "11px sans-serif";
    for (let d = 20; d < S * h.rangeCellSizeM; d += 20) {
      const y = sampleToY(viewH, d / h.rangeCellSizeM, S);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(P, y); ctx.stroke();
      if (idx === 0) ctx.fillText(`${d}m`, 4, y - 2);
    }
    // 网次区间
    for (const haul of h.hauls) {
      ctx.fillStyle = "rgba(74,168,255,0.08)";
      ctx.fillRect(haul.startPing, 0, haul.endPing - haul.startPing, viewH);
      ctx.fillStyle = "rgba(74,168,255,0.8)";
      ctx.fillText(haul.label, haul.startPing + 4, 12);
    }
    // 海底上 0.5 m 水层带
    if (showLayer) {
      ctx.fillStyle = "rgba(255,210,74,0.18)";
      const layerCells = 0.5 / h.rangeCellSizeM;
      ctx.beginPath();
      ctx.moveTo(0, sampleToY(viewH, bottom[0] - layerCells, S));
      for (let p = 0; p < P; p++) ctx.lineTo(p, sampleToY(viewH, bottom[p] - layerCells, S));
      for (let p = P - 1; p >= 0; p--) ctx.lineTo(p, sampleToY(viewH, bottom[p], S));
      ctx.closePath(); ctx.fill();
    }
    // 海底线
    if (showBottom) {
      ctx.strokeStyle = "#ffd24a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let p = 0; p < P; p++) {
        const y = sampleToY(viewH, bottom[p], S);
        if (p === 0) ctx.moveTo(0, y); else ctx.lineTo(p, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    // 目标框
    if (showSchools) {
      for (const s of schools) {
        const x = s.pingStart, w = s.pingEnd - s.pingStart + 1;
        const y = sampleToY(viewH, s.sampleTop, S);
        const hh = sampleToY(viewH, s.sampleBottom - s.sampleTop + 1, S);
        const isSel = s.id === selectedSchool;
        ctx.strokeStyle = s.kind === "fish" ? "#ff5a4e" : "#4ecf7a";
        ctx.lineWidth = isSel ? 3 : 1;
        ctx.strokeRect(x, y, w, Math.max(3, hh));
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`#${s.id}`, x + 2, Math.max(10, y - 2));
        ctx.lineWidth = 1;
      }
    }
  });
}

// 海底以上 0.5 m 水层拉平条带(上下各留一点上下文)
function renderStrip() {
  const { voyage, sv, bottom } = current!;
  const h = voyage.header;
  const P = h.pingCount, S = h.sampleCount, cell = h.rangeCellSizeM;
  const above = Math.round(1.5 / cell); // 海底线上方取 1.5 m
  const below = Math.round(0.5 / cell); // 线下方 0.5 m(看回波形态)
  const rows = above + below;
  const [c, ctx] = echoCanvas(P, rows);
  const data = ctx.createImageData(P, rows);
  const px = data.data;
  const layerCells = 0.5 / cell;
  for (let p = 0; p < P; p++) {
    const b = bottom[p];
    for (let r = 0; r < rows; r++) {
      const s = Math.round(b - above + r);
      const v = s >= 0 && s < S ? sv[0][p * S + s] : -120;
      const [rr, g, bb] = svColor(v);
      const o = (r * P + p) * 4;
      px[o] = rr; px[o + 1] = g; px[o + 2] = bb; px[o + 3] = 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  const strip = $("strip") as HTMLCanvasElement;
  strip.width = P; strip.height = rows;
  strip.style.width = `${P}px`;
  strip.style.height = "90px";
  const sctx = strip.getContext("2d")!;
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(c, 0, 0);
  // 海底线(黄实线)与海底上 0.5 m 线(黄虚线效果)
  sctx.strokeStyle = "#ffd24a";
  sctx.beginPath();
  for (let p = 0; p < P; p++) {
    const frac = bottom[p] - Math.round(bottom[p]);
    const y = above - frac;
    if (p === 0) sctx.moveTo(p, y); else sctx.lineTo(p, y);
  }
  sctx.stroke();
  sctx.strokeStyle = "rgba(255,210,74,0.5)";
  sctx.beginPath();
  for (let p = 0; p < P; p++) {
    const frac = bottom[p] - Math.round(bottom[p]);
    const y = above - layerCells - frac;
    if (p === 0) sctx.moveTo(p, y); else sctx.lineTo(p, y);
  }
  sctx.stroke();
}

function renderMap() {
  const { voyage, schools } = current!;
  const map = $("map") as HTMLCanvasElement;
  const W = map.clientWidth || 300, H = 240;
  map.width = W; map.height = H;
  const ctx = map.getContext("2d")!;
  ctx.fillStyle = "#0a1626";
  ctx.fillRect(0, 0, W, H);
  const lat = voyage.lat, lon = voyage.lon, P = voyage.header.pingCount;
  let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity;
  for (let p = 0; p < P; p++) {
    if (lat[p] < laMin) laMin = lat[p];
    if (lat[p] > laMax) laMax = lat[p];
    if (lon[p] < loMin) loMin = lon[p];
    if (lon[p] > loMax) loMax = lon[p];
  }
  const laPad = Math.max(0.002, (laMax - laMin) * 0.15);
  const loPad = Math.max(0.002, (loMax - loMin) * 0.15);
  const X = (lo: number) => ((lo - loMin + loPad) / (loMax - loMin + 2 * loPad)) * W;
  const Y = (la: number) => H - ((la - laMin + laPad) / (laMax - laMin + 2 * laPad)) * H;

  // 航迹
  ctx.strokeStyle = "#4aa8ff";
  ctx.beginPath();
  for (let p = 0; p < P; p += 5) {
    const x = X(lon[p]), y = Y(lat[p]);
    if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // 网次航段
  ctx.strokeStyle = "#ff9f2e";
  ctx.lineWidth = 3;
  for (const haul of voyage.header.hauls) {
    ctx.beginPath();
    for (let p = haul.startPing; p <= haul.endPing; p += 3) {
      const x = X(lon[p]), y = Y(lat[p]);
      if (p === haul.startPing) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  // 目标
  for (const s of schools) {
    const p = Math.round(s.centroidPing);
    const r = Math.max(2.5, Math.min(9, s.widthM / 12));
    ctx.beginPath();
    ctx.arc(X(lon[p]), Y(lat[p]), r, 0, Math.PI * 2);
    ctx.fillStyle = s.kind === "fish" ? "rgba(255,90,78,0.75)" : "rgba(78,207,122,0.55)";
    ctx.fill();
  }
  // 图例
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#ff5a4e"; ctx.fillText("●", 8, H - 10);
  ctx.fillStyle = "#d7e0ee"; ctx.fillText("鱼群", 20, H - 10);
  ctx.fillStyle = "#4ecf7a"; ctx.fillText("●", 60, H - 10);
  ctx.fillStyle = "#d7e0ee"; ctx.fillText("浮游层", 72, H - 10);
  ctx.fillStyle = "#ff9f2e"; ctx.fillText("—", 116, H - 10);
  ctx.fillStyle = "#d7e0ee"; ctx.fillText("网次", 128, H - 10);
  ctx.fillStyle = "#4aa8ff"; ctx.fillText("—", 160, H - 10);
  ctx.fillStyle = "#d7e0ee"; ctx.fillText("航迹", 172, H - 10);
}

function renderStats() {
  const { voyage, schools, bottom } = current!;
  const h = voyage.header;
  const fish = schools.filter((s) => s.kind === "fish");
  const plankton = schools.filter((s) => s.kind === "plankton");
  const near = fish.filter((s) => s.nearBottom);
  let dist = 0;
  for (let p = 1; p < h.pingCount; p++) dist += voyage.speedKn[p] * 0.5144 * h.pingIntervalSec;
  let bSum = 0;
  for (let p = 0; p < h.pingCount; p++) bSum += bottom[p];
  const meanBottom = (bSum / h.pingCount) * h.rangeCellSizeM;
  $("stats").innerHTML =
    `<span>船名 <b>${h.vessel}</b></span><span>出海 <b>${h.startTime.slice(0, 16).replace("T", " ")}</b></span>` +
    `<span>时长 <b>${(h.pingCount * h.pingIntervalSec / 3600).toFixed(1)} h</b></span>` +
    `<span>航程 <b>${(dist / 1852).toFixed(1)} nmi</b></span>` +
    `<span>平均水深 <b>${meanBottom.toFixed(0)} m</b></span>` +
    `<span>鱼群 <b>${fish.length}</b>(贴底 ${near.length})</span>` +
    `<span>浮游层 <b>${plankton.length}</b></span>`;
  $("hauls").innerHTML = h.hauls
    .map((haul) => {
      const t0 = new Date(new Date(h.startTime).getTime() + haul.startPing * h.pingIntervalSec * 1000);
      const t1 = new Date(new Date(h.startTime).getTime() + haul.endPing * h.pingIntervalSec * 1000);
      const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const n = schools.filter((s) => s.haulId === haul.id && s.kind === "fish").length;
      return `<span>${haul.label} ${hm(t0)}–${hm(t1)}(鱼群 ${n})</span>`;
    })
    .join("");
}

function renderSchoolTable() {
  const { schools } = current!;
  const rows = schools.map((s) => {
    const tag = s.kind === "fish"
      ? `<span class="tag fish">鱼群</span>`
      : `<span class="tag plankton">浮游层</span>`;
    const near = s.nearBottom && s.kind === "fish" ? `<span class="tag near">贴底</span>` : "";
    return `<tr class="school" data-id="${s.id}">
      <td class="l">#${s.id} ${tag}${near}</td>
      <td>${s.meanDepthM.toFixed(1)}</td>
      <td>${s.widthM.toFixed(0)}×${s.heightM.toFixed(1)}</td>
      <td>${s.meanSv38.toFixed(0)}</td>
      <td>${s.deltaSv >= 0 ? "+" : ""}${s.deltaSv.toFixed(1)}</td>
      <td>${s.haulId ?? "—"}</td>
    </tr>`;
  });
  $("schoollist").innerHTML =
    `<table><thead><tr><th class="l">目标</th><th>水深m</th><th>宽×厚m</th><th>Sv38</th><th>ΔSv</th><th>网次</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  document.querySelectorAll<HTMLTableRowElement>("tr.school").forEach((tr) => {
    tr.addEventListener("click", () => {
      selectedSchool = Number(tr.dataset.id);
      document.querySelectorAll("tr.school").forEach((r) => r.classList.toggle("sel", r === tr));
      const s = current!.schools.find((x) => x.id === selectedSchool)!;
      const wrap = $("echowrap");
      wrap.scrollLeft = s.centroidPing - wrap.clientWidth / 2;
      drawOverlays();
    });
  });
}

function showReadout(ev: MouseEvent, box: HTMLElement, viewH: number) {
  if (!current) return;
  const { voyage, sv, bottom } = current!;
  const h = voyage.header;
  const rect = box.getBoundingClientRect();
  const p = Math.max(0, Math.min(h.pingCount - 1, Math.floor(ev.clientX - rect.left)));
  const samp = Math.max(0, Math.min(h.sampleCount - 1, Math.round(yToSample(viewH, ev.clientY - rect.top, h.sampleCount))));
  const t = new Date(new Date(h.startTime).getTime() + p * h.pingIntervalSec * 1000);
  const depth = (samp + 0.5) * h.rangeCellSizeM;
  $("readout").textContent =
    `${t.toLocaleTimeString("zh-CN")}  水深 ${depth.toFixed(1)} m  ` +
    `Sv38 ${sv[0][p * h.sampleCount + samp].toFixed(1)} dB  Sv200 ${sv[1][p * h.sampleCount + samp].toFixed(1)} dB  ` +
    `海底 ${(bottom[p] * h.rangeCellSizeM).toFixed(1)} m`;
}

// ---------- 启动 ----------
async function main() {
  const index: IndexEntry[] = await (await fetch("/data/index.json")).json();
  const sel = $("voyage") as HTMLSelectElement;
  sel.innerHTML = index
    .map((e) => `<option value="${e.id}">${e.id} · ${e.vessel} · ${e.startTime.slice(5, 16).replace("T", " ")} · ${e.haulCount}网</option>`)
    .join("");
  sel.addEventListener("change", () => {
    const e = index.find((x) => x.id === sel.value)!;
    selectedSchool = null;
    loadVoyage(e);
  });
  for (const id of ["showBottom", "showLayer", "showSchools"]) {
    $(id).addEventListener("change", drawOverlays);
  }
  // 回波图与贴底层条带横向滚动同步
  $("echowrap").addEventListener("scroll", () => {
    $("stripwrap").scrollLeft = $("echowrap").scrollLeft;
  });
  if (index.length) loadVoyage(index[0]);
}
main();
