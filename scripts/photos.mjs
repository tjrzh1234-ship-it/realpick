// 공매 목록 카드에 쓸 대표 사진 1장 (온비드 부동산 물건상세 API: OnbidRlstDtlSrvc2/getRlstDtlInf2)
// - 사진 목록 중 지도(지적도·위치도)는 건너뛰고 첫 건물 사진을 고른다 (photo-kind.mjs)
// - 물건마다 한 번만 묻고 photo-cache.json (GitHub 캐시)에 저장한다. 사진 없는 물건은 14일 뒤 다시 확인.
// - 공공데이터포털 하루 호출 한도를 지키려고 한 번 실행에 새로 묻는 수를 PHOTO_LIMIT(기본 1500, 운영계정 기준)으로 제한.
//   마감이 가까운 물건부터 채우고, 남은 물건은 다음 날 이어서 채운다.
const API = "https://apis.data.go.kr/B010003/OnbidRlstDtlSrvc2/getRlstDtlInf2";
const LIMIT = Number(process.env.PHOTO_LIMIT || 1500), CONCURRENCY = 4, RECHECK_DAYS = 14;

import { photoKind } from "./photo-kind.mjs";

function photoList(j) {
  const b = j?.response?.body ?? j?.body ?? j;
  let it = b?.items?.item ?? b?.items ?? b?.item;
  if (Array.isArray(it)) it = it[0];
  let list = it?.potoUrlList;
  if (list && !Array.isArray(list)) list = Object.values(list).find(Array.isArray) || [list];
  const out = [];
  for (const p of list || []) {
    try { const u = new URL(String(p?.urlAdr || "")); if (/(^|\.)onbid\.co\.kr$/.test(u.hostname)) out.push(u); } catch { /* 다음 */ }
  }
  return out;
}
const big = u => { const x = new URL(u.href); x.searchParams.delete("downloadImageKind"); return x.href; };   // 원본(약 540px)
const thumb = u => { const x = new URL(u.href); x.searchParams.set("downloadImageKind", "THNL_NM"); return x.href; }; // 판단용 작은 사진
// 지도(지적도·위치도)가 아닌 첫 건물 사진을 고른다. 전부 지도면 첫 지도를 'm'으로 돌려준다.
async function pickPhoto(urls) {
  if (!urls.length) return ["", ""];
  for (const u of urls.slice(0, 8)) {
    try {
      const r = await fetch(thumb(u), { headers: { Referer: "https://www.onbid.co.kr/", "User-Agent": "Mozilla/5.0 (realpick)" } });
      if (!r.ok) continue;
      const k = await photoKind(new Uint8Array(await r.arrayBuffer()));
      if (k === null) return [big(urls[urls.length > 1 ? 1 : 0]), "?"];   // 판단 도구가 없으면: 보통 첫 장이 위치도라 둘째 장
      if (k === "p") return [big(u), "p"];
    } catch { /* 다음 사진 */ }
  }
  return [big(urls[0]), "m"];
}

export async function buildPhotos(key, { readJson, writeJson }) {
  const auc = await readJson("auctions.json", null);
  if (!auc?.items?.length) return console.log("대표 사진: auctions.json 없음");
  const cache = await readJson("photo-cache.json", {});
  const today = Date.now();
  const need = auc.items.filter(it => {
    const c = cache[it.id];
    if (!c || !c[2] || c[2] === "?") return true;              // 예전 방식으로 저장된 것은 다시 판단
    return !c[0] && today - Date.parse(c[1]) > RECHECK_DAYS * 864e5;
  });
  let asked = 0, got = 0, stop = "";
  let i = 0;
  const worker = async () => {
    while (i < need.length && asked < LIMIT && !stop) {
      const it = need[i++]; asked++;
      const cond = it.link?.[3] ? `&pbctCdtnNo=${encodeURIComponent(it.link[3])}` : "";
      try {
        const r = await fetch(`${API}?serviceKey=${encodeURIComponent(key)}&pageNo=1&numOfRows=1&resultType=json&cltrMngNo=${encodeURIComponent(it.id)}${cond}`, { headers: { Accept: "application/json" } });
        const t = await r.text();
        if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|SERVICE_KEY_IS_NOT_REGISTERED|ACCESS_DENIED/.test(t)) { stop = t.match(/[A-Z_]{12,}/)?.[0] || "한도"; break; }
        let j; try { j = JSON.parse(t); } catch { continue; }
        const [u, k] = await pickPhoto(photoList(j));
        cache[it.id] = [u, new Date().toISOString().slice(0, 10), k || "-"];
        if (k === "p") got++;
      } catch { /* 네트워크 오류는 다음에 다시 */ }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // 지난 물건은 캐시에서 정리
  const live = new Set(auc.items.map(it => it.id));
  for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
  let withPh = 0;
  // phk: 'p' 건물 사진, 'm' 지도뿐 (화면에서 토지만 지도를 보여준다)
  for (const it of auc.items) { const c = cache[it.id]; if (c?.[0]) { it.ph = c[0]; it.phk = c[2]; if (c[2] === "p") withPh++; } else { delete it.ph; delete it.phk; } }
  await writeJson("auctions.json", auc, true);
  await writeJson("photo-cache.json", cache, true);
  console.log(`대표 사진: 새로 확인 ${asked}건 (건물 사진 ${got}), 건물 사진 있는 물건 ${withPh}/${auc.items.length}건, 아직 확인 안 한 물건 ${Math.max(0, need.length - asked)}건`
    + (stop ? ` · 중단: ${stop} (공공데이터포털 하루 한도)` : ""));
}
