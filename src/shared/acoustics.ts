// 声学基础换算。所有 dB 量未特别说明时 re 1µPa。
// 数据文件里存的是"接收级 RL"(未做 TVG 的原始接收 dB 值 ×100, Int16),
// 岸上分析时自己做时变增益(TVG)校正得到体积散射强度 Sv。

export const SOUND_SPEED_MPS = 1490; // 12°C、35‰ 海水中的典型声速

/**
 * 海水声吸收系数,Francois–Garrison (1982) 的常用近似形式。
 * @param freqKhz 频率 kHz
 * @returns 吸收系数 α,单位 dB/km
 * 典型值:38 kHz ≈ 10 dB/km,200 kHz ≈ 55–65 dB/km。
 */
export function absorptionDbPerKm(
  freqKhz: number,
  tempC = 12,
  salinityPsu = 35,
  depthM = 50,
  ph = 8,
): number {
  const f = freqKhz;
  const f1 = 0.78 * Math.sqrt(salinityPsu / 35) * Math.exp(tempC / 26); // 硼酸弛豫频率
  const f2 = 42 * Math.exp(tempC / 17); // 硫酸镁弛豫频率
  const a1 =
    (0.106 * f1 * f * f) / (f1 * f1 + f * f) * Math.exp((ph - 8) / 0.56);
  const a2 =
    0.52 *
    (1 + tempC / 43) *
    (salinityPsu / 35) *
    ((f2 * f * f) / (f2 * f2 + f * f)) *
    Math.exp(-depthM / 6000);
  const a3 = 0.00049 * f * f * Math.exp(-(tempC / 27 + depthM / 17000));
  return a1 + a2 + a3;
}

/** 双程传播损失(球面扩展 + 吸收),即 TVG 需要补回的量,dB。 */
export function twoWayLossDb(rangeM: number, alphaDbPerKm: number): number {
  const r = Math.max(rangeM, 1);
  return 20 * Math.log10(r) + (2 * alphaDbPerKm * r) / 1000;
}

/**
 * 由原始接收级还原体积散射强度:
 *   Sv = RL - 系统常数K + 20log10(R) + 2αR
 * @param rawDb 接收级 dB(Int16 原始值 / 100)
 */
export function svFromRawDb(
  rawDb: number,
  rangeM: number,
  calibrationDb: number,
  alphaDbPerKm: number,
): number {
  return rawDb - calibrationDb + twoWayLossDb(rangeM, alphaDbPerKm);
}

/** 为整列距离单元预计算 TVG 修正量(Sv = raw - K + tvg[i])。 */
export function tvgColumn(
  sampleCount: number,
  cellSizeM: number,
  alphaDbPerKm: number,
): Float32Array {
  const tvg = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    tvg[i] = twoWayLossDb((i + 0.5) * cellSizeM, alphaDbPerKm);
  }
  return tvg;
}
