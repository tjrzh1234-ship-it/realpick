// 온비드 공매 물건 수집 + 국토부 실거래가 비교
// - 온비드:   한국자산관리공사_차세대 온비드 부동산 물건목록 조회서비스
// - 실거래가: 국토교통부 토지·상업업무용·아파트·연립다세대·단독다가구·오피스텔·공장창고 매매 신고 자료
// 모두 공공데이터포털(data.go.kr) 인증키 하나로 호출합니다 (환경변수 DATA_GO_KR_KEY).
//
// 비교 방식
//   1) 감정가 대비 최저입찰가 (온비드 자료)
//   2) 같은 동네·같은 종류 최근 12개월 실거래의 ㎡당 중앙값 × 물건 면적 = "주변 시세 추정"
//      아파트는 같은 단지·비슷한 면적 거래를 먼저 찾습니다.
//   실거래 공개 자료는 지번 일부가 가려져 있어 "이 물건의 직전 거래가"는 알 수 없습니다.
import { readFile } from "node:fs/promises";

const ONBID = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2";
const ONBID_DETAIL = "https://www.onbid.co.kr/op/cltrpbancinf/cltrdtl/CltrDtlController/mvmnCltrDtl.do";
const ONBID_SEARCH = "https://www.onbid.co.kr/op/cltrpbancinf/clbtcltrclg/cltrclbtcltrclg/CltrClbtCltrClgController/mvmnCltrRlstClg.do";
// 재산유형 코드: 압류·기타일반·국유·공유 등. 자료가 없는 코드는 NO_DATA로 바로 넘어간다 (예보·수탁 재산 확인용으로 넓게 조회)
const PRPT_DIVS = ["0007", "0005", "0010", "0002", "0008", "0001", "0003", "0004", "0006", "0009", "0011"];

const RT = "https://apis.data.go.kr/1613000";
export const RTMS = {
  land: { url: `${RT}/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade`, label: "토지" },
  nrg:  { url: `${RT}/RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade`,   label: "상업업무용" },
  apt:  { url: `${RT}/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`,   label: "아파트" },
  rh:   { url: `${RT}/RTMSDataSvcRHTrade2/getRTMSDataSvcRHTrade`,    label: "연립다세대" }, // 2026년 새 주소 (끝에 2)
  sh:   { url: `${RT}/RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade`,     label: "단독다가구" },
  offi: { url: `${RT}/RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade`, label: "오피스텔" },
  indu: { url: `${RT}/RTMSDataSvcInduTrade/getRTMSDataSvcInduTrade`, label: "공장창고" }
};
const MONTHS = 12;            // 비교에 쓰는 기간
const MAX_CALLS_PER_API = 900; // 실거래가 API마다 한 번 실행에 쓰는 호출 상한 (API별 하루 1,000회 한도 안쪽)

const SIDO_FULL = [
  ["서울", ["서울특별시", "서울시"]], ["부산", ["부산광역시"]], ["대구", ["대구광역시"]], ["인천", ["인천광역시"]],
  ["광주", ["광주광역시"]], ["대전", ["대전광역시"]], ["울산", ["울산광역시"]], ["세종", ["세종특별자치시"]],
  ["경기", ["경기도"]], ["강원", ["강원특별자치도", "강원도"]], ["충북", ["충청북도"]], ["충남", ["충청남도"]],
  ["전북", ["전북특별자치도", "전라북도"]], ["전남", ["전라남도"]], ["전남광주", ["전남광주통합특별시"]], ["경북", ["경상북도"]], ["경남", ["경상남도"]],
  ["제주", ["제주특별자치도"]]
];
const SHORTS = SIDO_FULL.map(s => s[0]);
export function sidoOf(sdNm, addr) {
  const s = String(sdNm || "").trim();
  if (SHORTS.includes(s)) return s;
  for (const [short, longs] of SIDO_FULL) if (longs.includes(s)) return short;
  // 주소 맨 앞 낱말만 본다 (세종대왕면 → 세종 같은 오인 방지)
  const head = String(addr || "").trim().split(/\s+/)[0];
  for (const [short, longs] of SIDO_FULL) if (head === short || longs.includes(head)) return short;
  return "";
}

const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : null; };
const digits = v => String(v || "").replace(/\D/g, "");
function dt(v) {
  const d = digits(v);
  if (/^(2999|9999)/.test(d)) return "";
  if (d.length >= 12) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
  if (d.length >= 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return "";
}
const keyDt = v => digits(v).slice(0, 12);
const nowKstDigits = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace(/\D/g, "").slice(0, 12);
export const normKey = k => { const s = String(k || "").trim(); try { return s.includes("%") ? decodeURIComponent(s) : s; } catch { return s; } };

/* ───────── 물건 종류 → 비교할 실거래 자료 ───────── */
const LAND_JIMOK = { "대지": "대", "대": "대", "전": "전", "답": "답", "과수원": "과수원", "임야": "임야", "잡종지": "잡종지", "공장용지": "공장용지", "창고용지": "창고용지", "주차장": "주차장", "도로": "도로", "구거": "구거", "하천": "하천", "목장용지": "목장용지", "학교용지": "학교용지", "주유소용지": "주유소용지", "종교용지": "종교용지", "체육용지": "체육용지", "유원지": "유원지", "묘지": "묘지", "제방": "제방", "유지": "유지", "공원": "공원", "광천지": "광천지", "염전": "염전", "사적지": "사적지", "철도용지": "철도용지", "수도용지": "수도용지", "양어장": "양어장" };
export function categoryOf(m, s, title) {
  const t = `${m || ""} ${s || ""}`;
  if (/아파트/.test(t)) return "apt";
  if (/오피스텔/.test(t)) return "offi";
  if (/다세대|연립|빌라/.test(t)) return "rh";
  if (/단독|다가구|주택/.test(t)) return "sh";
  if (/공장|창고/.test(t) && !/용지/.test(t)) return "indu";
  if (/근린|상가|업무|판매|숙박|사무|의료|교육|상업|노유자|위락|문화|종교시설/.test(t)) return "nrg";
  if (/토지/.test(m || "") || LAND_JIMOK[String(s || "").trim()]) return "land";
  return null;
}

/* ───────── 온비드 ───────── */
function parseOnbid(body) {
  let d = body?.response ?? body;
  const h = d?.header || d?.result || {};
  const rc = String(h.resultCode ?? "00"), msg = String(h.resultMsg ?? "");
  if (rc === "03" || /NODATA/i.test(msg)) return [];
  if (!["00", "0", "000", ""].includes(rc)) throw new Error(`온비드 API 오류 ${rc}: ${msg}`);
  let items = d?.body?.items ?? [];
  if (items && !Array.isArray(items)) items = items.item ?? [];
  if (items && !Array.isArray(items)) items = [items];
  return items.filter(i => i && typeof i === "object");
}
async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  return text;
}
function apiErrorFromXml(text) {
  const auth = text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1];
  const reason = text.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1];
  if (auth) return `${auth} (${reason || "-"})`;
  const rc = text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1];
  const rm = text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1];
  if (rc && !["00", "000", "0"].includes(rc.trim())) return `${rc} ${rm || ""}`.trim();
  return null;
}
async function fetchOnbidRows(key, log) {
  const rows = [], errors = [];
  for (const div of PRPT_DIVS) {
    for (let page = 1; page <= 40; page++) {
      const u = new URL(ONBID);
      Object.entries({ serviceKey: key, pageNo: page, numOfRows: 500, resultType: "json", prptDivCd: div, pvctTrgtYn: "N" })
        .forEach(([k, v]) => u.searchParams.set(k, v));
      let items;
      try {
        const text = (await fetchText(u.href)).trim();
        if (text.startsWith("<")) { const m = apiErrorFromXml(text) || text.slice(0, 120); if (!/NO_?DATA/i.test(m)) errors.push(`${div}: ${m}`); break; }
        items = parseOnbid(JSON.parse(text));
      } catch (e) { errors.push(`${div} p${page}: ${e.message}`); break; }
      rows.push(...items);
      if (items.length < 500) break;
    }
    log(`  온비드 재산유형 ${div}: 누적 ${rows.length}행`);
  }
  return { rows, errors };
}
function detailUrl(r) {
  const keys = ["onbidCltrno", "onbidPbancNo", "pbctNo", "pbctCdtnNo"];
  if (!keys.every(k => r[k])) return ONBID_SEARCH;
  const q = new URLSearchParams({ cltrScrnGrpCd: "0001", cltrPrptDivCd: r.prptDivCd || r.cltrPrptDivCd || "" });
  keys.forEach(k => q.set(k, r[k]));
  return `${ONBID_DETAIL}?${q}`;
}
const STATUS_NAME = { "0001": "입찰준비중", "0002": "입찰진행중", "0003": "입찰마감", "0006": "개찰중", "0009": "수의계약가능", "0010": "낙찰", "0011": "유찰", "0012": "취소" };

// 회차 단위 행 → 물건 단위 (아직 끝나지 않은 가장 이른 회차)
export function toAuctionItems(raw, sgg, nowDigits = nowKstDigits()) {
  // 온비드가 준 필지코드(PNU)로 "시도 시군구 → 코드"를 배워 둔다 (2026년 새로 생긴 시·구도 처리)
  const learned = {};
  for (const r of raw) {
    const p = digits(r.ltnoPnu); if (p.length < 5) continue;
    const a = (r.zadrNm || r.cltrAdr || "").trim(), sd = sidoOf(r.lctnSdnm, a), sg = String(r.lctnSggnm || "").trim();
    if (sd && sg) learned[`${sd} ${sg}`] = p.slice(0, 5);
  }
  const groups = new Map();
  for (const r of raw) { const no = r.cltrMngNo; if (no) (groups.get(no) || groups.set(no, []).get(no)).push(r); }
  const out = [];
  for (const [no, rounds] of groups) {
    const live = rounds.filter(r => { const e = keyDt(r.cltrBidEndDt); return e && !/^(2999|9999)/.test(e) && e >= nowDigits.slice(0, e.length); });
    if (!live.length) continue;
    const cur = live.sort((a, b) => (keyDt(a.cltrBidBgngDt) || "9").localeCompare(keyDt(b.cltrBidBgngDt) || "9"))[0];
    if (/임대/.test(cur.dspsMthodNm || "")) continue;
    const addr = (cur.zadrNm || cur.cltrAdr || cur.cltrRadr || [cur.lctnSdnm, cur.lctnSggnm, cur.lctnEmdNm].filter(Boolean).join(" ")).trim();
    const sido = sidoOf(cur.lctnSdnm, addr);
    const sggNm = String(cur.lctnSggnm || "").trim();
    const pnu = digits(cur.ltnoPnu);
    const sggCd = pnu.length >= 5 ? pnu.slice(0, 5) : (sido === "세종" ? "36110" : (learned[`${sido} ${sggNm}`] || sgg[`${sido} ${sggNm}`] || sgg[`${sido} ${sggNm.split(" ")[0]}`] || null));
    const usageM = cur.cltrUsgMclsCtgrNm || "", usageS = cur.cltrUsgSclsCtgrNm || "";
    const title = String(cur.onbidCltrNm || addr || no).trim();
    const landA = num(cur.landSqms), bldA = num(cur.bldSqms);
    const apsl = num(cur.apslEvlAmt), minp = num(cur.lowstBidPrcIndctCont) ?? num(cur.lowstBidPrc);
    let status = String(cur.pbctStatNm || "");
    if (!status || /^\d+$/.test(status)) status = STATUS_NAME[status || cur.pbctStatCd] || status;
    out.push({
      id: String(no), title, addr, sido, sgg: sggNm, emd: String(cur.lctnEmdNm || "").trim(), sggCd, pnu: pnu || null,
      usage: [usageM, usageS].filter(Boolean).join(" > "), cat: categoryOf(usageM, usageS, title), jimok: LAND_JIMOK[String(usageS).trim()] || null,
      share: /지분/.test(title),
      bundle: /외\s*\d*\s*필지|등\s*\d+\s*필지|\d+\s*필지|외\s*\d+\s*개|및\s*(지상)?\s*(건물|건축물)|토지\s*및\s*건물|일괄/.test(title),
      landArea: landA, bldArea: bldA,
      apsl, minp, ratio: apsl && minp ? Math.round(minp / apsl * 1000) / 10 : null,
      fails: num(cur.usbdNft) ?? 0, prpt: cur.prptDivNm || "", org: cur.orgNm || cur.rqstOrgNm || "",
      method: cur.dspsMthodNm || "", status,
      bidStart: dt(cur.cltrBidBgngDt), bidEnd: dt(cur.cltrBidEndDt),
      // 온비드 상세 주소 재료 (화면에서 주소를 만든다: 파일 크기 절약)
      link: ["onbidCltrno", "onbidPbancNo", "pbctNo", "pbctCdtnNo"].every(k => cur[k]) ? [cur.onbidCltrno, cur.onbidPbancNo, cur.pbctNo, cur.pbctCdtnNo, cur.prptDivCd || cur.cltrPrptDivCd || ""].map(String) : null
    });
  }
  return out;
}

/* ───────── 실거래가 (XML) ───────── */
export function parseRtmsXml(xml) {
  const err = apiErrorFromXml(xml);
  if (err) throw new Error(err);
  const total = num(xml.match(/<totalCount>(\d+)<\/totalCount>/)?.[1]) ?? 0;
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = f[2].trim();
    items.push(o);
  }
  return { total, items };
}
// 비교에 필요한 값만 남긴다: [동, 면적㎡, 금액(만원), 꼬리표, 거래일]
export function compactDeal(cat, it) {
  if (String(it.cdealType || "").trim() === "O") return null;           // 해제된 거래
  if (/지분/.test(it.shareDealingType || "")) return null;               // 지분 거래
  const amt = num(it.dealAmount);
  const area = cat === "land" ? num(it.dealArea)
    : cat === "nrg" || cat === "indu" ? num(it.buildingAr)
    : cat === "sh" ? (num(it.totalFloorAr) ?? num(it.plottageAr))
    : num(it.excluUseAr);
  if (!amt || !area) return null;
  const tag = cat === "land" ? (it.jimok || "") : cat === "apt" ? (it.aptNm || "") : cat === "offi" ? (it.offiNm || "")
    : cat === "rh" ? (it.mhouseNm || "") : cat === "nrg" ? (it.buildingUse || "") : cat === "sh" ? (it.houseType || "") : (it.buildingUse || "");
  const day = `${it.dealYear}-${String(it.dealMonth).padStart(2, "0")}-${String(it.dealDay || 1).padStart(2, "0")}`;
  return [String(it.umdNm || "").trim(), Math.round(area * 100) / 100, amt, String(tag).trim(), day];
}
function ymList(n) {
  const d = new Date(Date.now() + 9 * 3600e3), out = [];
  for (let i = 0; i < n; i++) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(`${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}`); }
  return out;
}
// 주소가 새 버전(…2)으로 바뀌는 경우가 있어, 안 되면 다른 이름을 차례로 시도하고 되는 주소를 기억한다
function urlCandidates(cat) {
  const m = RTMS[cat].url.match(/^(.*\/)(RTMSDataSvc\w+?)(2?)\/(get\w+?)(2?)$/);
  if (!m) return [RTMS[cat].url];
  const [, root, svc, , op] = m, list = [RTMS[cat].url];
  for (const s of [svc + "2", svc]) for (const o of [op, op + "2"]) list.push(`${root}${s}/${o}`);
  return [...new Set(list)];
}
const workingUrl = {}, urlErrors = {};
async function rtmsCall(key, cat, params) {
  const cands = workingUrl[cat] ? [workingUrl[cat]] : urlCandidates(cat);
  let lastErr;
  for (const base of cands) {
    const u = new URL(base);
    Object.entries({ serviceKey: key, ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
    try { const r = parseRtmsXml(await fetchText(u.href)); workingUrl[cat] = base; return r; }
    catch (e) {
      lastErr = e; (urlErrors[cat] ||= {})[base.replace(/^.*1613000\//, "")] = String(e.message).slice(0, 60);
      if (/LIMITED_NUMBER|HTTP 429/i.test(e.message) || workingUrl[cat]) throw e;
    }
  }
  throw lastErr;
}
async function fetchRtmsMonth(key, cat, sggCd, ym) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const { total, items } = await rtmsCall(key, cat, { LAWD_CD: sggCd, DEAL_YMD: ym, pageNo: page, numOfRows: 1000 });
    for (const it of items) { const c = compactDeal(cat, it); if (c) rows.push(c); }
    if (page * 1000 >= total) return { rows, calls: page };
  }
  return { rows, calls: 20 };
}

/* ───────── 비교 계산 ───────── */
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const sameDong = (deal, item) => {
  const u = deal[0]; if (!u) return false;
  const last = item.emd.split(/\s+/).pop();
  return !!last && (u === item.emd || u.endsWith(last) || item.emd.endsWith(u) || item.addr.includes(u));
};
export function compareItem(item, deals) {
  if (!item.cat || !deals) return null;
  if (item.share) return { skip: "지분 물건은 면적 기준 비교에서 뺐어요" };
  if (item.bundle) return { skip: "여러 필지·건물을 묶은 물건이라 면적 기준 비교에서 뺐어요" };
  const area = item.cat === "land" ? (item.landArea || null) : (item.bldArea || (item.cat === "sh" ? item.landArea : null));
  if (!area || !item.minp) return null;
  if (!item.apsl) return { skip: "감정가가 없어 비교 결과를 검증할 수 없어 생략했어요" };
  const within = (d, lo, hi) => d[1] >= area * lo && d[1] <= area * hi;
  const tries = [];
  if (item.cat === "apt" || item.cat === "offi" || item.cat === "rh") {
    const names = [...new Set(deals.map(d => d[3]).filter(n => n && n.length >= 2 && item.title.includes(n)))];
    if (names.length) tries.push(["같은 단지 비슷한 면적", deals.filter(d => names.includes(d[3]) && within(d, .85, 1.15)), 1]);
    tries.push(["같은 동 비슷한 면적", deals.filter(d => sameDong(d, item) && within(d, .8, 1.2)), 3]);
    tries.push(["같은 시군구 비슷한 면적", deals.filter(d => within(d, .8, 1.2)), 5]);
  } else if (item.cat === "land") {
    const j = item.jimok;
    const dong = deals.filter(d => sameDong(d, item)), sz = d => within(d, .2, 5);
    if (j) tries.push([`같은 동 같은 지목(${j})`, dong.filter(d => d[3] === j && sz(d)), 3]);
    tries.push(["같은 동 토지", dong.filter(sz), 3]);
    if (j) tries.push([`같은 시군구 같은 지목(${j})`, deals.filter(d => d[3] === j && sz(d)), 5]);
  } else {
    tries.push(["같은 동", deals.filter(d => sameDong(d, item) && within(d, .3, 3)), 3]);
    tries.push(["같은 시군구", deals.filter(d => within(d, .3, 3)), 5]);
  }
  const hit = tries.find(([, list, min]) => list.length >= min);
  if (!hit) return { skip: "비교할 만한 최근 실거래가 부족해요" };
  const [basis, list] = hit;
  const perM2 = median(list.map(d => d[2] * 10000 / d[1]));
  const est = Math.round(perM2 * area);
  // 감정가와 3배 넘게 차이 나면 면적·용도 정보가 맞지 않는 경우가 대부분이라 숫자를 보여주지 않는다
  if (item.apsl && (est > item.apsl * 3 || est < item.apsl / 3)) return { skip: "주변 실거래와 감정가 차이가 너무 커서 비교를 생략했어요" };
  const recent = [...list].sort((a, b) => b[4].localeCompare(a[4])).slice(0, 5)
    .map(d => ({ dong: d[0], area: d[1], amount: d[2] * 10000, tag: d[3] || null, date: d[4] }));
  return {
    basis: `${basis} · 최근 ${MONTHS}개월 ${list.length}건`, count: list.length,
    perM2: Math.round(perM2), est, area,
    minVsEst: Math.round((item.minp / est - 1) * 1000) / 10,
    apslVsEst: item.apsl ? Math.round((item.apsl / est - 1) * 1000) / 10 : null,
    samples: recent
  };
}

/* ───────── 실행 ───────── */
export async function buildAuctions(key, { readJson, writeJson, nowKST, log = console.log }) {
  key = normKey(key);
  const sgg = JSON.parse(await readFile(new URL("./sgg-codes.json", import.meta.url), "utf8"));
  const { rows, errors } = await fetchOnbidRows(key, log);
  if (!rows.length) throw new Error("온비드 응답이 비었어요. " + (errors[0] || "활용신청 승인 여부를 확인하세요."));
  const items = toAuctionItems(rows, sgg);
  log(`  온비드: 회차 ${rows.length}행 → 진행 중 물건 ${items.length}건${errors.length ? ` (오류 ${errors.length}건: ${errors[0]})` : ""}`);

  // 실거래가 캐시: 지난달 이전 자료는 거의 바뀌지 않으므로 한 번 받으면 재사용
  const cache = await readJson("rtms-cache.json", { v: 1, entries: {} });
  const months = ymList(MONTHS), recentSet = new Set(months.slice(0, 2));
  const need = new Map(); // "cat:sgg" -> 물건 수
  for (const it of items) if (it.cat && it.sggCd && !it.share) { const k = `${it.cat}:${it.sggCd}`; need.set(k, (need.get(k) || 0) + 1); }
  const order = [...need.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  let calls = 0; const failedApis = new Map(), callsByApi = {}, apiErrors = {};
  const tasks = [];
  for (const k of order) for (const ym of months) {
    const ck = `${k}:${ym}`, e = cache.entries[ck];
    const stale = !e || (recentSet.has(ym) && Date.now() - Date.parse(e.t) > 3 * 864e5);
    if (stale) tasks.push([k, ym, ck]);
  }
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const [k, ym, ck] = tasks[i++]; const [cat, sggCd] = k.split(":");
      if (failedApis.has(cat) || (callsByApi[cat] || 0) >= MAX_CALLS_PER_API) continue;
      try {
        const r = await fetchRtmsMonth(key, cat, sggCd, ym); calls += r.calls; callsByApi[cat] = (callsByApi[cat] || 0) + r.calls;
        cache.entries[ck] = { t: new Date().toISOString(), rows: r.rows };
      } catch (e) {
        calls++; callsByApi[cat] = (callsByApi[cat] || 0) + 1;
        const m = String(e.message);
        const why = /LIMITED_NUMBER|HTTP 429/i.test(m) ? "quota" : /SERVICE_KEY|NOT_REGISTERED|ACCESS_DENIED|NO_OPENAPI|UNREGISTERED/i.test(m) ? "auth" : null;
        apiErrors[RTMS[cat].label] = (m.match(/[A-Z_]{8,}_ERROR|[A-Z_]{8,}/)?.[0] || m).slice(0, 80);
        if (why) failedApis.set(cat, why);
      }
    }
  }
  await Promise.all([1, 2, 3, 4].map(worker));
  // 12개월보다 오래된 캐시 정리
  for (const ck of Object.keys(cache.entries)) if (!months.includes(ck.split(":")[2])) delete cache.entries[ck];
  const pending = tasks.filter(([, , ck]) => !cache.entries[ck]).length;
  log(`  실거래가: 호출 ${calls}회, 남은 조회 ${pending}건${failedApis.size ? `, 사용 못한 자료: ${[...failedApis].map(([c, m]) => `${RTMS[c].label}(${m})`).join(", ")}` : ""}`);

  let compared = 0;
  for (const it of items) {
    if (!it.cat || !it.sggCd) { it.compare = it.cat ? { skip: "시군구 코드를 찾지 못했어요" } : null; continue; }
    const keys = months.map(ym => `${it.cat}:${it.sggCd}:${ym}`);
    if (failedApis.get(it.cat) === "auth" && keys.some(k => !cache.entries[k])) { it.compare = { skip: `${RTMS[it.cat].label} 실거래가 자료를 쓸 수 없어요 (활용신청 확인)` }; continue; }
    if (keys.some(k => !cache.entries[k])) { it.compare = { pending: true, skip: "주변 실거래 시세를 모으는 중이에요" }; continue; }
    it.compare = compareItem(it, keys.flatMap(k => cache.entries[k].rows));
    if (it.compare && !it.compare.skip) compared++;
  }
  items.sort((a, b) => (a.bidEnd || "9").localeCompare(b.bidEnd || "9"));
  // 화면에 필요한 값만 남겨 파일을 가볍게
  const slim = items.map(it => {
    const o = { ...it, area: it.cat === "land" ? it.landArea : (it.bldArea ?? it.landArea) };
    for (const k of ["pnu", "emd", "jimok", "bundle", "sggCd"]) delete o[k];
    if (!o.share) delete o.share;
    if (o.compare?.samples) o.compare = { ...o.compare, samples: o.compare.samples.slice(0, 3) };
    if (o.compare?.pending) o.compare = { pending: true, skip: o.compare.skip };
    return o;
  });
  await writeJson("rtms-cache.json", cache, true);
  await writeJson("auctions.json", {
    source: "한국자산관리공사 온비드 · 국토교통부 실거래가 (공공데이터포털)", updatedAt: nowKST(),
    note: `주변 시세 추정은 같은 동네·같은 종류의 최근 ${MONTHS}개월 실거래 ㎡당 중앙값에 물건 면적을 곱한 값입니다. 실제 시세나 낙찰가와 다를 수 있습니다.`,
    stats: { items: items.length, compared, rtmsCalls: calls, callsByApi, pending, apiErrors, urlErrors: Object.fromEntries(Object.entries(urlErrors).filter(([c]) => !workingUrl[c])), workingUrl },
    items: slim
  }, true);
  log(`auctions.json: 물건 ${items.length}건, 시세 비교 ${compared}건`);
}
