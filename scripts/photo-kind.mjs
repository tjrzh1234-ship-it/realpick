// 온비드 사진이 '지도(지적도·위치도)'인지 '건물 사진'인지 그림만 보고 가른다.
// 온비드 사진 목록에는 종류 표시가 없어서, 밝은 픽셀 비율과 단색 면적으로 판단한다.
//  - 지도: 거의 모든 픽셀이 밝고(흰 바탕·노란 필지) 같은 색 면이 넓다 → bright 0.97 이상
//  - 건물 사진: 하늘·벽·그림자가 섞여 밝은 픽셀이 절반 안팎 → bright 0.6 이하
// GitHub Actions 에서는 jpeg-js, pngjs (순수 JS 패키지)를 쓴다. 없으면 null 을 돌려줘 호출한 쪽이 판단한다.
let dec = null;
async function decoders() {
  if (dec !== null) return dec;
  try {
    const [j, p] = await Promise.all([import("jpeg-js"), import("pngjs")]);
    dec = { jpeg: j.default || j, png: (p.default || p).PNG };
  } catch { dec = false; }
  return dec;
}
export function kindOfPixels(data, w, h) {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 72));
  let n = 0, bright = 0; const q = new Map();
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    n++; if (Math.max(r, g, b) > 170) bright++;
    const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4); q.set(k, (q.get(k) || 0) + 1);
  }
  const br = bright / n, top6 = [...q.values()].sort((a, b) => b - a).slice(0, 6).reduce((s, v) => s + v, 0) / n;
  return br > 0.9 || (br > 0.8 && top6 > 0.45) ? "m" : "p";
}
// buf: 이미지 바이트 → "m"(지도) | "p"(사진) | null(판단 불가)
export async function photoKind(buf) {
  const d = await decoders(); if (!d) return null;
  try {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let img;
    if (u8[0] === 0xff && u8[1] === 0xd8) img = d.jpeg.decode(u8, { useTArray: true, maxResolutionInMP: 20, formatAsRGBA: true });
    else if (u8[0] === 0x89 && u8[1] === 0x50) img = d.png.sync.read(Buffer.from(u8));
    else return null;
    return kindOfPixels(img.data, img.width, img.height);
  } catch { return null; }
}
