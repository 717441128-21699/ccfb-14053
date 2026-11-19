// 合成航次回声数据生成器。
// 按真实声学过程生成:球面扩展 + 频率相关吸收(Francois–Garrison)、
// 接收机噪声底、船体升沉(海底线锯齿的来源)、海底多次回波、
// 鱼群(低频强)/浮游层(高频强)的频率响应差异。
// 运行:node src/gen/generate.ts
// 输出:data/*.fvoy + data/index.json + data/*.truth.json(真值,供 validate.ts 校验)

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SOUND_SPEED_MPS,
  absorptionDbPerKm,
  twoWayLossDb,
} from "../shared/acoustics.ts";
import { encodeVoyage, type Haul, type VoyageFile } from "../shared/format.ts";

// ---------- 可复现随机数 ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 场景参数 ----------
const CELL_M = 0.25; // 距离单元 0.25 m
const SAMPLES = 600; // 量程 150 m
const PING_DT = 1.0; // 1 ping/秒
const FREQS = [38000, 200000];
const CALIB_DB = [30, 28]; // 系统常数 K(SL+接收增益的集总),Sv = RL - K + TVG
const NOISE_RL_DB = -112; // 接收机等效噪声(常值 RL,TVG 校正后随距离上升)

interface SchoolDef {
  x0: number; x1: number; // 沿航迹起止(米)
  depthCenter: number; // 中心水深(米,真值坐标,不含升沉)
  halfW: number; halfH: number;
  peakSv38: number;
  deltaSv: number; // Sv200 - Sv38
}
interface LayerDef {
  depthAt(x: number): number; // 层中心深度
  thickness: number;
  sv38: number;
  deltaSv: number;
}
interface VoyageSpec {
  id: string;
  vessel: string;
  startTime: string;
  seed: number;
  durationMin: number;
  startLat: number; startLon: number;
  legs: { headingDeg: number; minutes: number }[];
  haulWindows: { startMin: number; endMin: number }[]; // 网次(放网到起网)
  dayTime: boolean;
}

function bottomProfile(x: number, seed: number): number {
  // 60~115 m 的海底起伏:长波地形 + 中波 + 小起伏 + 一处海岭
  const s1 = Math.sin(x / 800 + seed * 0.7) * 22;
  const s2 = Math.sin(x / 233 + 1.7 + seed) * 10;
  const s3 = Math.sin(x / 61 + seed * 2.3) * 3.5;
  const ridge = -14 * Math.exp(-((x - 9000 - seed * 500) ** 2) / (2 * 900 ** 2));
  return 68 + s1 + s2 + s3 + ridge;
}

function generateVoyage(spec: VoyageSpec) {
  const rand = mulberry32(spec.seed);
  const P = Math.round((spec.durationMin * 60) / PING_DT);
  const alpha = FREQS.map((f) => absorptionDbPerKm(f / 1000));
  const tvg = FREQS.map((_, f) => {
    const t = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) t[i] = twoWayLossDb((i + 0.5) * CELL_M, alpha[f]);
    return t;
  });

  // --- 航迹与航速 ---
  const lat = new Float32Array(P);
  const lon = new Float32Array(P);
  const speedKn = new Float32Array(P);
  const distM = new Float32Array(P); // 累计航程
  const hauls: Haul[] = spec.haulWindows.map((w, i) => ({
    id: `H${i + 1}`,
    label: `第${i + 1}网`,
    startPing: Math.round((w.startMin * 60) / PING_DT),
    endPing: Math.round((w.endMin * 60) / PING_DT),
  }));
  {
    let la = spec.startLat, lo = spec.startLon, heading = 0, x = 0;
    let legIdx = 0, legEndPing = spec.legs[0].minutes * 60;
    heading = spec.legs[0].headingDeg;
    for (let p = 0; p < P; p++) {
      if (p >= legEndPing && legIdx < spec.legs.length - 1) {
        legIdx++;
        legEndPing += spec.legs[legIdx].minutes * 60;
        heading = spec.legs[legIdx].headingDeg;
      }
      const t = p * PING_DT;
      const inHaul = hauls.some((h) => p >= h.startPing && p <= h.endPing);
      const spd = (inHaul ? 3.1 : 4.6) + (rand() - 0.5) * 0.3;
      speedKn[p] = spd;
      const v = spd * 0.5144;
      x += v * PING_DT;
      distM[p] = x;
      const rad = (heading * Math.PI) / 180;
      la += (v * PING_DT * Math.cos(rad)) / 111320;
      lo += (v * PING_DT * Math.sin(rad)) / (111320 * Math.cos((la * Math.PI) / 180));
      lat[p] = la; lon[p] = lo;
      void t;
    }
  }

  // --- 升沉(海底线锯齿的来源) ---
  const heave = new Float32Array(P);
  {
    const ph1 = rand() * 6.28, ph2 = rand() * 6.28;
    for (let p = 0; p < P; p++) {
      const t = p * PING_DT;
      heave[p] =
        0.45 * Math.sin((2 * Math.PI * t) / 7.5 + ph1) +
        0.15 * Math.sin((2 * Math.PI * t) / 3.1 + ph2) +
        (rand() - 0.5) * 0.1;
    }
  }

  // --- 浮游层 ---
  const layers: LayerDef[] = spec.dayTime
    ? [
        { depthAt: (x) => 52 + 8 * Math.sin(x / 1500), thickness: 9, sv38: -73, deltaSv: 11 },
        { depthAt: (x) => 78 + 6 * Math.sin(x / 900 + 2), thickness: 6, sv38: -75, deltaSv: 13 },
      ]
    : [
        { depthAt: (x) => 22 + 5 * Math.sin(x / 1200), thickness: 8, sv38: -71, deltaSv: 10 },
        { depthAt: (x) => 45 + 7 * Math.sin(x / 700 + 1), thickness: 5, sv38: -75, deltaSv: 14 },
      ];

  // --- 鱼群 ---
  const schools: SchoolDef[] = [];
  {
    const nSchools = 10 + Math.floor(rand() * 5);
    const totalDist = distM[P - 1];
    for (let s = 0; s < nSchools; s++) {
      const xc = 1500 + rand() * (totalDist - 3000);
      const halfW = 15 + rand() * 55;
      const halfH = 2 + rand() * 5;
      const nearBottom = rand() < 0.45; // 约一半是难办的贴底鱼群
      const bottomHere = bottomProfile(xc, spec.seed);
      // 贴底群落在海底回波主瓣(约 2 m)之外、5.8 m 以内 —— 正是肉眼分不清的那一段
      const depthCenter = nearBottom
        ? bottomHere - (2.8 + rand() * 3)
        : 15 + rand() * (bottomHere - 25);
      schools.push({
        x0: xc - halfW, x1: xc + halfW,
        depthCenter, halfW, halfH,
        peakSv38: -56 + rand() * 14,
        deltaSv: -9 + rand() * 10, // 鱼:ΔSv ∈ [-9, +1]
      });
    }
  }

  // --- 逐 ping 渲染 ---
  const channels = FREQS.map(() => new Int16Array(P * SAMPLES));
  const trueBottomSample = new Float32Array(P); // 真值(含升沉),供校验
  const db2lin = (db: number) => Math.pow(10, db / 10);

  for (let p = 0; p < P; p++) {
    const x = distM[p];
    const hv = heave[p];
    const bottomTrue = bottomProfile(x, spec.seed);
    const bottomApp = bottomTrue + hv; // 表观海底深度(升沉整体平移水柱)
    trueBottomSample[p] = bottomApp / CELL_M;
    const bottomSvBase = -13 + 3 * Math.sin(x / 500 + spec.seed) + (rand() - 0.5) * 1.5;
    const multipleApp = 2 * bottomApp; // 海底多次回波
    const activeSchools = schools.filter((s) => x >= s.x0 - 1 && x <= s.x1 + 1);
    const base = p * SAMPLES;

    for (let i = 0; i < SAMPLES; i++) {
      const depth = (i + 0.5) * CELL_M;
      const depthTrue = depth - hv; // 还原到真值坐标系查场景
      // 各散射贡献先在 Sv 域算出,再换成"接收级线性功率"累加
      let acc0 = 0, acc1 = 0;

      // 浮游层
      for (const L of layers) {
        const dz = (depthTrue - L.depthAt(x)) / (L.thickness / 2);
        if (dz > -3 && dz < 3) {
          const shape = Math.exp(-dz * dz);
          const sv = L.sv38 + 10 * Math.log10(shape + 1e-3);
          acc0 += db2lin(sv - tvg[0][i]);
          acc1 += db2lin(sv + L.deltaSv - tvg[1][i]);
        }
      }
      // 鱼群
      for (const sc of activeSchools) {
        const dx = (x - (sc.x0 + sc.x1) / 2) / sc.halfW;
        const dz = (depthTrue - sc.depthCenter) / sc.halfH;
        const r2 = dx * dx + dz * dz;
        if (r2 < 1.2) {
          const shape = Math.max(0, 1 - r2);
          const sv = sc.peakSv38 + 10 * Math.log10(shape + 0.04);
          acc0 += db2lin(sv - tvg[0][i]);
          acc1 += db2lin(sv + sc.deltaSv - tvg[1][i]);
        }
      }
      // 海底:主瓣(脉宽决定厚度,σ=0.4 m)+ 下方指数尾
      const dzB = depth - bottomApp;
      if (dzB > -2 && dzB < 10) {
        const main = Math.exp(-(dzB * dzB) / (2 * 0.4 * 0.4));
        const tail = dzB > 0 ? 0.35 * Math.exp(-dzB / 2.2) : 0;
        const sv = bottomSvBase + 10 * Math.log10(main + tail + 1e-4);
        acc0 += db2lin(sv - tvg[0][i]);
        acc1 += db2lin(sv - 2 - tvg[1][i]); // 海底高频略弱
      }
      // 海底多次回波(量程够才出现)
      if (multipleApp < 148) {
        const dzM = depth - multipleApp;
        if (dzM > -1.5 && dzM < 6) {
          const main = Math.exp(-(dzM * dzM) / (2 * 0.9 * 0.9));
          const sv = bottomSvBase - 14 + 10 * Math.log10(main + 1e-4);
          acc0 += db2lin(sv - tvg[0][i]);
          acc1 += db2lin(sv - 2 - tvg[1][i]);
        }
      }

      // 接收机噪声(常值 RL)+ 指数分布散斑
      const speckle = -Math.log(Math.max(rand(), 1e-9));
      const noiseLin = db2lin(NOISE_RL_DB) * speckle;
      const rl0 = 10 * Math.log10(acc0 * db2lin(CALIB_DB[0]) + noiseLin);
      const rl1 = 10 * Math.log10(acc1 * db2lin(CALIB_DB[1]) + noiseLin);
      channels[0][base + i] = Math.max(-32768, Math.min(32767, Math.round(rl0 * 100)));
      channels[1][base + i] = Math.max(-32768, Math.min(32767, Math.round(rl1 * 100)));
    }
  }

  const voyage: VoyageFile = {
    header: {
      voyageId: spec.id,
      vessel: spec.vessel,
      startTime: spec.startTime,
      pingIntervalSec: PING_DT,
      pingCount: P,
      sampleCount: SAMPLES,
      rangeCellSizeM: CELL_M,
      frequenciesHz: FREQS,
      soundSpeedMps: SOUND_SPEED_MPS,
      calibrationDb: CALIB_DB,
      absorptionDbPerKm: alpha,
      hauls,
    },
    lat, lon, speedKn, channels,
  };
  const truth = {
    bottomSample: Array.from(trueBottomSample, (v) => Math.round(v * 100) / 100),
    schools: schools.map((s) => ({
      x0: s.x0, x1: s.x1, depthCenter: s.depthCenter,
      halfW: s.halfW, halfH: s.halfH, peakSv38: s.peakSv38, deltaSv: s.deltaSv,
    })),
  };
  return { voyage, truth };
}

// ---------- 三个航次 ----------
const specs: VoyageSpec[] = [
  {
    id: "V20260611-night", vessel: "浙渔01234", startTime: "2026-06-11T19:20:00+08:00",
    seed: 11, durationMin: 150, startLat: 30.12, startLon: 122.61,
    legs: [
      { headingDeg: 85, minutes: 50 }, { headingDeg: 140, minutes: 45 },
      { headingDeg: 60, minutes: 55 },
    ],
    haulWindows: [
      { startMin: 22, endMin: 58 }, { startMin: 75, endMin: 108 }, { startMin: 120, endMin: 146 },
    ],
    dayTime: false,
  },
  {
    id: "V20260612-day", vessel: "浙渔01234", startTime: "2026-06-12T08:05:00+08:00",
    seed: 23, durationMin: 160, startLat: 30.05, startLon: 122.74,
    legs: [
      { headingDeg: 210, minutes: 60 }, { headingDeg: 160, minutes: 40 },
      { headingDeg: 250, minutes: 60 },
    ],
    haulWindows: [
      { startMin: 18, endMin: 52 }, { startMin: 66, endMin: 101 }, { startMin: 115, endMin: 150 },
    ],
    dayTime: true,
  },
  {
    id: "V20260613-dusk", vessel: "浙渔01234", startTime: "2026-06-13T16:40:00+08:00",
    seed: 37, durationMin: 140, startLat: 29.98, startLon: 122.68,
    legs: [
      { headingDeg: 30, minutes: 45 }, { headingDeg: 100, minutes: 50 },
      { headingDeg: 350, minutes: 45 },
    ],
    haulWindows: [
      { startMin: 15, endMin: 48 }, { startMin: 60, endMin: 95 }, { startMin: 105, endMin: 132 },
    ],
    dayTime: false,
  },
];

mkdirSync("data", { recursive: true });
const index = [];
for (const spec of specs) {
  const t0 = Date.now();
  const { voyage, truth } = generateVoyage(spec);
  const buf = encodeVoyage(voyage);
  const file = `${spec.id}.fvoy`;
  writeFileSync(join("data", file), Buffer.from(buf));
  writeFileSync(join("data", `${spec.id}.truth.json`), JSON.stringify(truth));
  index.push({
    id: spec.id,
    file,
    vessel: spec.vessel,
    startTime: spec.startTime,
    durationMin: spec.durationMin,
    pingCount: voyage.header.pingCount,
    frequenciesHz: FREQS,
    haulCount: voyage.header.hauls.length,
    sizeBytes: buf.byteLength,
  });
  console.log(
    `${spec.id}: ${voyage.header.pingCount} pings, ${(buf.byteLength / 1e6).toFixed(1)} MB, ` +
    `${voyage.header.hauls.length} 网, 生成耗时 ${Date.now() - t0} ms`,
  );
}
writeFileSync(join("data", "index.json"), JSON.stringify(index, null, 2));
console.log("完成 → data/index.json");
