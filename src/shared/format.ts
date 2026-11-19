// 航次回声数据文件格式 (.fvoy) —— 二进制,小端。
//
// 布局:
//   0   4 字节  magic "FVOY"
//   4   u32     格式版本 (当前 1)
//   8   u32     头部 JSON 字节长度
//   12  JSON    头部 (VoyageHeader)
//   ... 数据体,顺序固定:
//        lat     Float32 × pingCount        (度)
//        lon     Float32 × pingCount        (度)
//        speed   Float32 × pingCount        (节)
//        通道0   Int16 × pingCount*sampleCount  (接收级 dB × 100,ping 主序)
//        通道1   Int16 × pingCount*sampleCount
//        (通道数 = header.frequenciesHz.length)
//
// 这样设计的原因:数据体是定长 typed array 的直接视图,解码零拷贝,
// 一个航次(约 25 MB)从磁盘读到可渲染远小于 5 秒。

export const MAGIC = 0x594f5646; // "FVOY" 小端
export const FORMAT_VERSION = 1;

export interface Haul {
  id: string;
  label: string; // 网次名,如 "第1网"
  startPing: number;
  endPing: number;
}

export interface VoyageHeader {
  voyageId: string;
  vessel: string;
  startTime: string; // ISO
  pingIntervalSec: number;
  pingCount: number;
  sampleCount: number;
  rangeCellSizeM: number; // 距离单元,米
  frequenciesHz: number[]; // [38000, 200000]
  soundSpeedMps: number;
  calibrationDb: number[]; // 每通道系统常数 K(Sv = RL - K + TVG)
  absorptionDbPerKm: number[]; // 每通道 α
  hauls: Haul[];
}

export interface VoyageFile {
  header: VoyageHeader;
  lat: Float32Array;
  lon: Float32Array;
  speedKn: Float32Array;
  /** channels[f] : Int16,ping 主序,值 = 接收级 dB × 100 */
  channels: Int16Array[];
}

export function encodeVoyage(v: VoyageFile): ArrayBuffer {
  const h = v.header;
  let headerBytes = new TextEncoder().encode(JSON.stringify(h));
  // 头部填充到 4 字节对齐,保证后面的 typed array 视图偏移合法(JSON 允许尾部空白)
  if (headerBytes.length % 4 !== 0) {
    const padded = new Uint8Array(headerBytes.length + (4 - (headerBytes.length % 4)));
    padded.set(headerBytes);
    padded.fill(0x20, headerBytes.length);
    headerBytes = padded;
  }
  const n = h.pingCount;
  const cells = n * h.sampleCount;
  const bodyBytes = n * 4 * 3 + cells * 2 * h.frequenciesHz.length;
  const buf = new ArrayBuffer(12 + headerBytes.length + bodyBytes);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, FORMAT_VERSION, true);
  dv.setUint32(8, headerBytes.length, true);
  new Uint8Array(buf, 12, headerBytes.length).set(headerBytes);
  let off = 12 + headerBytes.length;
  new Float32Array(buf, off, n).set(v.lat); off += n * 4;
  new Float32Array(buf, off, n).set(v.lon); off += n * 4;
  new Float32Array(buf, off, n).set(v.speedKn); off += n * 4;
  for (const ch of v.channels) {
    if (ch.length !== cells) throw new Error("通道长度与头部不符");
    new Int16Array(buf, off, cells).set(ch);
    off += cells * 2;
  }
  return buf;
}

export function decodeVoyage(buf: ArrayBuffer): VoyageFile {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("不是 FVOY 文件");
  if (dv.getUint32(4, true) !== FORMAT_VERSION) throw new Error("不支持的格式版本");
  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 12, headerLen)),
  ) as VoyageHeader;
  const n = header.pingCount;
  const cells = n * header.sampleCount;
  let off = 12 + headerLen;
  const lat = new Float32Array(buf, off, n); off += n * 4;
  const lon = new Float32Array(buf, off, n); off += n * 4;
  const speedKn = new Float32Array(buf, off, n); off += n * 4;
  const channels: Int16Array[] = [];
  for (let f = 0; f < header.frequenciesHz.length; f++) {
    channels.push(new Int16Array(buf, off, cells));
    off += cells * 2;
  }
  return { header, lat, lon, speedKn, channels };
}
