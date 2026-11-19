// 校验:对生成的航次跑海底检测与鱼群识别,和真值对比。
// 运行:node src/gen/validate.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeVoyage } from "../shared/format.ts";
import { tvgColumn } from "../shared/acoustics.ts";
import { detectBottom } from "../shared/bottom.ts";
import { detectSchools } from "../shared/schools.ts";

function toSv(raw: Int16Array, calib: number, tvg: Float32Array, S: number): Float32Array {
  const out = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) {
    out[k] = raw[k] / 100 - calib + tvg[k % S];
  }
  return out;
}

const index = JSON.parse(readFileSync(join("data", "index.json"), "utf8"));
for (const entry of index) {
  const t0 = Date.now();
  const v = decodeVoyage(readFileSync(join("data", entry.file)).buffer as ArrayBuffer);
  const h = v.header;
  const S = h.sampleCount, P = h.pingCount;
  const tvg0 = tvgColumn(S, h.rangeCellSizeM, h.absorptionDbPerKm[0]);
  const tvg1 = tvgColumn(S, h.rangeCellSizeM, h.absorptionDbPerKm[1]);
  const sv38 = toSv(v.channels[0], h.calibrationDb[0], tvg0, S);
  const sv200 = toSv(v.channels[1], h.calibrationDb[1], tvg1, S);

  // --- 海底检测精度 ---
  const bottom = detectBottom(sv38, {
    pingCount: P, sampleCount: S, cellSizeM: h.rangeCellSizeM,
  });
  const truth = JSON.parse(readFileSync(join("data", `${entry.id}.truth.json`), "utf8"));
  const errs: number[] = [];
  for (let p = 0; p < P; p++) errs.push(Math.abs(bottom[p] - truth.bottomSample[p]));
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const p95 = errs[Math.floor(errs.length * 0.95)];
  const max = errs[errs.length - 1];
  const within1 = errs.filter((e) => e <= 1).length / errs.length;

  // --- 鱼群识别 ---
  const schools = detectSchools(sv38, sv200, bottom, h, v.speedKn);
  const fish = schools.filter((s) => s.kind === "fish");
  const plankton = schools.filter((s) => s.kind === "plankton");
  const nearBottom = fish.filter((s) => s.nearBottom);

  // 与真值鱼群逐一比对:真值中心落在检测框(放宽 50%)内算命中
  const distM = new Float32Array(P);
  let xAcc = 0;
  for (let p = 0; p < P; p++) { xAcc += v.speedKn[p] * 0.5144 * h.pingIntervalSec; distM[p] = xAcc; }
  let hit = 0;
  const missed: string[] = [];
  for (const ts of truth.schools) {
    const xc = (ts.x0 + ts.x1) / 2;
    let ping = 0;
    while (ping < P - 1 && distM[ping] < xc) ping++;
    const samp = ts.depthCenter / h.rangeCellSizeM;
    const found = schools.some((s) => {
      const pw = (s.pingEnd - s.pingStart) * 0.75;
      const hh = (s.sampleBottom - s.sampleTop) * 0.75;
      const cp = (s.pingStart + s.pingEnd) / 2;
      const cs = (s.sampleTop + s.sampleBottom) / 2;
      return Math.abs(ping - cp) <= pw + 2 && Math.abs(samp - cs) <= hh + 2;
    });
    if (found) hit++;
    else missed.push(`深${ts.depthCenter.toFixed(1)}m 半宽${ts.halfW.toFixed(0)}m 半高${ts.halfH.toFixed(1)}m peak${ts.peakSv38.toFixed(0)}dB`);
  }

  console.log(`\n== ${entry.id} ==  (分析耗时 ${Date.now() - t0} ms)`);
  console.log(
    `  海底检测: 平均误差 ${mean.toFixed(2)} 单元, 95% 分位 ${p95.toFixed(2)}, ` +
    `最大 ${max.toFixed(2)}, ≤1 单元比例 ${(within1 * 100).toFixed(1)}%`,
  );
  console.log(
    `  目标识别: 共 ${schools.length} 个,鱼群 ${fish.length}(其中贴底 ${nearBottom.length}),` +
    `浮游层 ${plankton.length};真值鱼群 ${truth.schools.length} 个,命中 ${hit}`,
  );
  if (missed.length) console.log(`  漏检: ${missed.join(" | ")}`);
}
