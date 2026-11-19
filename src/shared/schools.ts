// 鱼群自动识别与双频分类。
//
// 原理:鱼(有鳔)在 38 kHz 上散射强,200 kHz 反而弱,ΔSv = Sv200 - Sv38 通常为负;
// 浮游动物(磷虾、水母类)高频散射强,ΔSv 明显为正。
//
// 流程(双阈值区域生长,与商用软件的鱼群检测同思路):
//   1. 核心掩膜(高阈值,默认 -66 dB):只有鱼群核心够强,浮游层(-71 dB 以下)进不来,
//      这样鱼群即使叠在浮游层上也不会被层"吞并";
//   2. 每个核心连通域以其峰值 Sv 动态确定生长阈值(峰值 -14 dB,不低于低阈值),
//      向外做区域生长得到完整目标;
//   3. 低阈值掩膜中不属于任何鱼群的大块连通域 → 浮游层候选;
//   4. 逐目标统计特征,按 ΔSv 分类(鱼 < +5 dB ≤ 浮游层)。

import type { VoyageHeader } from "./format.ts";

export type SchoolKind = "fish" | "plankton";

export interface School {
  id: number;
  kind: SchoolKind;
  pingStart: number;
  pingEnd: number;
  sampleTop: number;
  sampleBottom: number;
  centroidPing: number;
  centroidSample: number;
  areaCells: number;
  widthM: number; // 沿航迹水平宽度(由航速×ping数估算)
  heightM: number; // 垂直厚度
  meanDepthM: number; // 质心水深
  meanSv38: number;
  meanSv200: number;
  deltaSv: number; // Sv200 - Sv38
  minDistToBottomM: number; // 目标下缘距海底线的最小距离
  nearBottom: boolean; // 贴底目标
  haulId: string | null; // 所在网次
}

export interface SchoolDetectOptions {
  coreThresholdSv?: number; // 核心高阈值,默认 -66 dB
  thresholdSv?: number; // 低阈值(浮游层分割用),默认 -78 dB
  growRangeDb?: number; // 区域生长动态范围(峰值向下),默认 14 dB
  minAreaCells?: number; // 鱼群最小面积,默认 12 单元
  minPingSpan?: number; // 最小水平跨度,默认 3 ping
  minSampleSpan?: number; // 最小垂直跨度,默认 3 单元
  minPlanktonAreaCells?: number; // 浮游层最小面积,默认 200 单元
  surfaceBlindM?: number; // 表层盲区,默认 3 m
  /** 海底回波主瓣屏蔽深度:海底线以上该距离内的单元不参与水层目标检测。
   *  海底回波主瓣会伸到海底线上方约 2 m,不屏蔽会把整段海床连成一个巨目标。默认 2.5 m */
  bottomBackoffM?: number;
  bottomMarginM?: number; // 距底多近算贴底目标,默认 3.5 m
  planktonDeltaSv?: number; // ΔSv 超过此值判浮游层,默认 +5 dB
}

interface Region {
  cells: number[]; // 展平下标
}

export function detectSchools(
  sv38: Float32Array,
  sv200: Float32Array,
  bottom: Float32Array,
  header: VoyageHeader,
  speedKn: Float32Array,
  o: SchoolDetectOptions = {},
): School[] {
  const P = header.pingCount;
  const S = header.sampleCount;
  const cell = header.rangeCellSizeM;
  const coreThr = o.coreThresholdSv ?? -66;
  const lowThr = o.thresholdSv ?? -78;
  const growRange = o.growRangeDb ?? 14;
  const minArea = o.minAreaCells ?? 12;
  const minPingSpan = o.minPingSpan ?? 3;
  const minSampleSpan = o.minSampleSpan ?? 3;
  const minPlanktonArea = o.minPlanktonAreaCells ?? 200;
  const surfaceBlind = Math.round((o.surfaceBlindM ?? 3) / cell);
  const backoffCells = Math.round((o.bottomBackoffM ?? 2.5) / cell);
  const bottomMarginM = o.bottomMarginM ?? 3.5;
  const planktonDelta = o.planktonDeltaSv ?? 5;

  // 1) 双阈值掩膜(避开表层盲区与海底回波主瓣)
  const maskLow = new Uint8Array(P * S);
  const maskCore = new Uint8Array(P * S);
  for (let p = 0; p < P; p++) {
    const bLim = Math.floor(bottom[p]) - backoffCells;
    const base = p * S;
    for (let i = surfaceBlind; i < bLim && i < S; i++) {
      const v = sv38[base + i];
      if (v >= lowThr) maskLow[base + i] = 1;
      if (v >= coreThr) maskCore[base + i] = 1;
    }
  }

  // 2) 核心连通域 → 以峰值动态阈值区域生长
  const coreLabel = new Int32Array(P * S);
  const cores: { cells: number[]; peak: number }[] = [];
  {
    const stack: number[] = [];
    for (let idx = 0; idx < P * S; idx++) {
      if (!maskCore[idx] || coreLabel[idx]) continue;
      const id = cores.length + 1;
      const cells: number[] = [];
      let peak = -Infinity;
      stack.push(idx);
      coreLabel[idx] = id;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        if (sv38[c] > peak) peak = sv38[c];
        const cp = Math.floor(c / S), ci = c % S;
        for (let dp = -1; dp <= 1; dp++) {
          for (let di = -1; di <= 1; di++) {
            if (!dp && !di) continue;
            const np = cp + dp, ni = ci + di;
            if (np < 0 || np >= P || ni < 0 || ni >= S) continue;
            const n = np * S + ni;
            if (maskCore[n] && !coreLabel[n]) { coreLabel[n] = id; stack.push(n); }
          }
        }
      }
      cores.push({ cells, peak });
    }
  }

  const claimed = new Uint8Array(P * S); // 已被鱼群区域占用的低阈值单元
  const fishRegions: Region[] = [];
  for (const core of cores) {
    const regionThr = Math.max(lowThr, core.peak - growRange);
    const seen = new Uint8Array(P * S);
    const cells: number[] = [];
    const stack: number[] = [...core.cells];
    for (const c of core.cells) seen[c] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      if (sv38[c] < regionThr) continue;
      cells.push(c);
      claimed[c] = 1;
      const cp = Math.floor(c / S), ci = c % S;
      for (let dp = -1; dp <= 1; dp++) {
        for (let di = -1; di <= 1; di++) {
          if (!dp && !di) continue;
          const np = cp + dp, ni = ci + di;
          if (np < 0 || np >= P || ni < 0 || ni >= S) continue;
          const n = np * S + ni;
          if (maskLow[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    fishRegions.push({ cells });
  }

  // 3) 低阈值掩膜中剩余的大块连通域 → 浮游层候选
  const planktonRegions: Region[] = [];
  {
    const seen = new Uint8Array(P * S);
    const stack: number[] = [];
    for (let idx = 0; idx < P * S; idx++) {
      if (!maskLow[idx] || claimed[idx] || seen[idx]) continue;
      const cells: number[] = [];
      stack.push(idx);
      seen[idx] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        const cp = Math.floor(c / S), ci = c % S;
        for (let dp = -1; dp <= 1; dp++) {
          for (let di = -1; di <= 1; di++) {
            if (!dp && !di) continue;
            const np = cp + dp, ni = ci + di;
            if (np < 0 || np >= P || ni < 0 || ni >= S) continue;
            const n = np * S + ni;
            if (maskLow[n] && !claimed[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
      }
      if (cells.length >= minPlanktonArea) planktonRegions.push({ cells });
    }
  }

  // 4) 特征提取与分类
  const schools: School[] = [];
  let id = 1;
  const build = (region: Region, presumptive: SchoolKind): School | null => {
    let pMin = P, pMax = 0, sMin = S, sMax = 0;
    let sumP = 0, sumS = 0, sum38 = 0, sum200 = 0, sumSpeed = 0, minBD = Infinity;
    for (const c of region.cells) {
      const p = Math.floor(c / S), i = c % S;
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
      if (i < sMin) sMin = i;
      if (i > sMax) sMax = i;
      sumP += p; sumS += i;
      sum38 += sv38[c]; sum200 += sv200[c];
      sumSpeed += speedKn[p];
      const d = bottom[p] - i;
      if (d < minBD) minBD = d;
    }
    const n = region.cells.length;
    const pingSpan = pMax - pMin + 1;
    const sampleSpan = sMax - sMin + 1;
    const meanSv38 = sum38 / n;
    const meanSv200 = sum200 / n;
    const deltaSv = meanSv200 - meanSv38;
    const kind: SchoolKind =
      presumptive === "plankton" || deltaSv >= planktonDelta ? "plankton" : "fish";
    const centroidPing = sumP / n;
    const centroidSample = sumS / n;
    const meanSpeedKn = sumSpeed / n;
    let haulId: string | null = null;
    for (const h of header.hauls) {
      if (centroidPing >= h.startPing && centroidPing <= h.endPing) { haulId = h.id; break; }
    }
    const minDistToBottomM = minBD * cell;
    return {
      id: id++,
      kind,
      pingStart: pMin, pingEnd: pMax,
      sampleTop: sMin, sampleBottom: sMax,
      centroidPing, centroidSample,
      areaCells: n,
      widthM: pingSpan * header.pingIntervalSec * meanSpeedKn * 0.5144,
      heightM: sampleSpan * cell,
      meanDepthM: (centroidSample + 0.5) * cell,
      meanSv38, meanSv200, deltaSv,
      minDistToBottomM,
      nearBottom: minDistToBottomM <= bottomMarginM,
      haulId,
    };
  };

  for (const r of fishRegions) {
    const pSpan = 1 + Math.floor(r.cells[r.cells.length - 1] / S) - Math.floor(r.cells[0] / S);
    void pSpan;
    const s = build(r, "fish");
    if (!s) continue;
    const pingSpan = s.pingEnd - s.pingStart + 1;
    const sampleSpan = s.sampleBottom - s.sampleTop + 1;
    if (s.areaCells < minArea || pingSpan < minPingSpan || sampleSpan < minSampleSpan) continue;
    schools.push(s);
  }
  for (const r of planktonRegions) {
    const s = build(r, "plankton");
    if (s) schools.push(s);
  }
  schools.sort((a, b) => a.centroidPing - b.centroidPing);
  schools.forEach((s, i) => (s.id = i + 1));
  return schools;
}
