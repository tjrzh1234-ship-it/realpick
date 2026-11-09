// 주소 → 좌표 (지도 표시용). 카카오 로컬 API, 환경변수 KAKAO_REST_KEY (카카오 개발자 앱의 'REST API 키')
// - auctions.json, housing.json 의 각 물건에 la(위도)·lo(경도)·geo('a' 번지까지 정확 / 'd' 동 중심) 를 붙인다
// - 한 번 찾은 주소는 geo-cache.json (GitHub 캐시에 보관)에 저장해 다시 묻지 않는다
const API = "https://dapi.kakao.com/v2/local/search/address.json";
const NEW_LIMIT = 4000, CONCURRENCY = 4;

function lotAddress(text) {
  // "경기도 부천시 소사구 괴안동 111-47 제9층 제903호 아파트" → "경기도 부천시 소사구 괴안동 111-47"
  const s = String(text || "").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?(?:동|리|가|읍|면)\d*\s+(?:산\s*)?\d+(?:-\d+)?)(?=\s|,|외|번지|$)/);
  if (m) return m[1];
  const r = s.match(/^(.+?(?:로|길)\s*\d+(?:-\d+)?)(?=\s|,|$)/);       // 도로명 주소
  return r ? r[1] : null;
}
function areaAddress(text) {
  const s = String(text || "").replace(/\(.*?\)/g, " ").replace(/일원|일대|외\s*\d+\s*필지|외\s*\d+\s*筆/g, " ").replace(/\s+/g, " ").trim();
  const t = s.split(" ");
  const i = t.findIndex(w => /(동|리|가|읍|면)\d*$/.test(w) && !/(시|군|구)$/.test(w));
  return i >= 1 ? t.slice(0, i + 1).join(" ") : t.slice(0, 3).join(" ");
}

export async function geocodeAll(key, { readJson, writeJson }) {
  const cache = await readJson("geo-cache.json", {});
  let asked = 0, found = 0, failed = 0, authErr = "";
  async function ask(q) {
    if (!q) return null;
    if (q in cache) return cache[q];
    if (asked >= NEW_LIMIT || authErr) return undefined;
    asked++;
    try {
      const res = await fetch(`${API}?size=1&query=${encodeURIComponent(q)}`, { headers: { Authorization: `KakaoAK ${key.trim()}` } });
      if (res.status === 401 || res.status === 403) { authErr = `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`; return undefined; }
      if (res.status === 429) { authErr = "HTTP 429 하루 사용량 초과"; return undefined; }
      if (!res.ok) { failed++; return undefined; }
      const j = await res.json(); const d = j.documents?.[0];
      cache[q] = d ? [+(+d.y).toFixed(6), +(+d.x).toFixed(6)] : 0;
      if (d) found++;
      return cache[q];
    } catch { failed++; return undefined; }
  }
  async function locate(exactText, areaText) {
    const lot = lotAddress(exactText);
    const a = await ask(lot); if (a) return [...a, "a"];
    const area = areaAddress(areaText || exactText);
    const b = await ask(area); if (b) return [...b, "d"];
    return null;
  }
  async function run(items, getText) {
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const it = items[i++];
        if (it.la && it.geo === "a") continue;
        const [exact, area] = getText(it);
        const r = await locate(exact, area);
        if (r) [it.la, it.lo, it.geo] = r;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  const auc = await readJson("auctions.json", null);
  if (auc?.items) {
    await run(auc.items, it => [it.title, it.addr]);
    await writeJson("auctions.json", auc, true);
  }
  const hs = await readJson("housing.json", null);
  if (hs?.items) {
    await run(hs.items.filter(i => i.addr), it => [it.addr, it.addr]);
    await writeJson("housing.json", hs, true);
  }
  await writeJson("geo-cache.json", cache, true);
  const withXY = (auc?.items || []).filter(i => i.la).length;
  console.log(`좌표: 새로 조회 ${asked}건 (찾음 ${found}, 실패 ${failed}), 공매 ${withXY}/${auc?.items?.length || 0}건 좌표 있음`
    + (authErr ? ` · 중단: ${authErr} (카카오 REST API 키와 '카카오맵' 사용 설정을 확인하세요)` : ""));
}
