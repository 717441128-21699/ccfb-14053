// 海底自动检测。
//
// 难点:船体升沉让海底线在回波图上呈锯齿状,单 ping 独立找底会跳变。
// 做法:每 ping 先取若干候选点(局部极大、强度够高),再用动态规划
// (Viterbi)在 ping 之间强制连续性,最后抛物线插值到亚单元精度。
// 在信噪比正常时误差稳定在一个距离单元以内。

export interface BottomDetectOptions {
  pingCount: number;
  sampleCount: number;
  cellSizeM: number;
  minDepthM?: number; // 盲区/换能器吃水以下的起始搜索深度,默认 5 m
  candidatesPerPing?: number; // 每 ping 候选数,默认 8
  /** 相邻 ping 海底最多跳变多少单元,超出重罚。默认 6 */
  maxStepCells?: number;
  /** 海底回波最低强度 dB,低于此值不视为候选。默认 -45 */
  minBottomSvDb?: number;
}

/**
 * @param sv 38 kHz 通道 Sv(ping 主序 Float32Array)
 * @returns 每 ping 海底所在的距离单元(浮点,亚单元精度)
 */
export function detectBottom(
  sv: Float32Array,
  o: BottomDetectOptions,
): Float32Array {
  const P = o.pingCount;
  const S = o.sampleCount;
  const K = o.candidatesPerPing ?? 8;
  const maxStep = o.maxStepCells ?? 6;
  const minSv = o.minBottomSvDb ?? -45;
  const minSample = Math.max(1, Math.round((o.minDepthM ?? 5) / o.cellSizeM));

  // 1) 每 ping 选候选:对 3 单元滑动平均后的列取局部极大,按强度取前 K 个
  const candIdx: Uint16Array[] = new Array(P);
  const candVal: Float32Array[] = new Array(P);
  const smooth = new Float32Array(S);
  for (let p = 0; p < P; p++) {
    const col = p * S;
    for (let i = 0; i < S; i++) {
      const a = sv[col + Math.max(0, i - 1)];
      const b = sv[col + i];
      const c = sv[col + Math.min(S - 1, i + 1)];
      smooth[i] = (a + b + c) / 3;
    }
    const idx: number[] = [];
    const val: number[] = [];
    for (let i = minSample; i < S - 1; i++) {
      if (
        smooth[i] >= smooth[i - 1] &&
        smooth[i] >= smooth[i + 1] &&
        smooth[i] > minSv
      ) {
        idx.push(i);
        val.push(smooth[i]);
      }
    }
    if (idx.length === 0) {
      // 没有明显峰:取搜索窗内最大值点兜底
      let bi = minSample, bv = -Infinity;
      for (let i = minSample; i < S; i++) {
        if (smooth[i] > bv) { bv = smooth[i]; bi = i; }
      }
      idx.push(bi); val.push(bv);
    }
    // 取强度前 K
    const order = idx.map((_, i) => i).sort((a, b) => val[b] - val[a]);
    const top = order.slice(0, K).sort((a, b) => idx[a] - idx[b]);
    candIdx[p] = new Uint16Array(top.map((i) => idx[i]));
    candVal[p] = new Float32Array(top.map((i) => val[i]));
  }

  // 2) Viterbi:代价 = -强度 + 跳变惩罚(超过 maxStep 急剧上升)
  const NEG = 1e9;
  let prevCost = new Float64Array(K);
  let nextCost = new Float64Array(K);
  const back: Uint8Array[] = new Array(P);
  for (let k = 0; k < candVal[0].length; k++) prevCost[k] = -candVal[0][k] * 2;
  for (let p = 1; p < P; p++) {
    const nk = candIdx[p].length;
    const pk = candIdx[p - 1].length;
    const bp = new Uint8Array(nk);
    for (let k = 0; k < nk; k++) {
      let best = NEG, bestJ = 0;
      const ci = candIdx[p][k];
      for (let j = 0; j < pk; j++) {
        const d = Math.abs(ci - candIdx[p - 1][j]);
        // 跳变惩罚:小跳变线性,超过 maxStep 平方暴涨 —— 允许真实地形起伏,压制野点
        const pen = d <= maxStep ? d * 1.5 : maxStep * 1.5 + (d - maxStep) ** 2 * 4;
        const c = prevCost[j] + pen;
        if (c < best) { best = c; bestJ = j; }
      }
      nextCost[k] = best - candVal[p][k] * 2;
      bp[k] = bestJ;
    }
    back[p] = bp;
    const t = prevCost; prevCost = nextCost; nextCost = t;
    if (nk < K) prevCost.fill(NEG, nk);
  }
  // 回溯
  let bestK = 0;
  for (let k = 1; k < candVal[P - 1].length; k++) {
    if (prevCost[k] < prevCost[bestK]) bestK = k;
  }
  const path = new Uint16Array(P);
  path[P - 1] = candIdx[P - 1][bestK];
  let k = bestK;
  for (let p = P - 1; p > 0; p--) {
    k = back[p][k];
    path[p - 1] = candIdx[p - 1][k];
  }

  // 3) 抛物线插值到亚单元
  const out = new Float32Array(P);
  for (let p = 0; p < P; p++) {
    const i = path[p];
    const col = p * S;
    if (i > 0 && i < S - 1) {
      const a = sv[col + i - 1], b = sv[col + i], c = sv[col + i + 1];
      const denom = a - 2 * b + c;
      const shift = Math.abs(denom) > 1e-6 ? 0.5 * (a - c) / denom : 0;
      out[p] = i + Math.max(-0.5, Math.min(0.5, shift));
    } else {
      out[p] = i;
    }
  }
  return out;
}

/**
 * 海底以上 0.5 m 水层掩膜:对每个 ping,把 [bottom-0.5m, bottom] 内的单元标 1。
 * 返回 Uint8Array(ping 主序),供"贴底层"单独查看/统计。
 */
export function bottomLayerMask(
  pingCount: number,
  sampleCount: number,
  bottom: Float32Array,
  cellSizeM: number,
  layerM = 0.5,
): Uint8Array {
  const mask = new Uint8Array(pingCount * sampleCount);
  const layerCells = layerM / cellSizeM;
  for (let p = 0; p < pingCount; p++) {
    const b = bottom[p];
    const lo = Math.max(0, Math.ceil(b - layerCells));
    const hi = Math.min(sampleCount - 1, Math.floor(b));
    for (let i = lo; i <= hi; i++) mask[p * sampleCount + i] = 1;
  }
  return mask;
}
