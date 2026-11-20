// 온비드 입찰결과 → market.json (공매 시장 리포트의 낙찰가율·낙찰률·경쟁 추이)
// 공공데이터포털 "한국자산관리공사_차세대 온비드 물건 입찰결과목록 조회서비스" (DATA_GO_KR_KEY)
// - 월 단위로 모아 시·도 × 종류별 통계만 저장 (화면에 올리는 파일을 작게 유지)
// - 매일: 지난달 1일 ~ 어제를 다시 받아 그 두 달을 새로 계산, 그 이전 달은 비어 있으면 채움(최대 12개월)
import { categoryOf, sidoOf, normKey } from "./auctions.mjs";

const BASE = "https://apis.data.go.kr/B010003/OnbidCltrBidRsltListSrvc2";
const OPS = ["getCltrBidRsltList2", "getCltrBidRsltList", "getOnbidCltrBidRsltList2", "getOnbidCltrBidRsltList"];
const PRPT = "0002,0003,0005,0006,0007,0008,0010,0011,0013";
const MONTHS = 12, ROWS = 1000;
const MAX_CALLS = Number(process.env.MARKET_MAX_CALLS || 600);
const CATS = ["apt", "offi", "rh", "sh", "land", "nrg", "indu", "etc"];
const FB = [0, 1, 2, 3, 4, 5, 6, 10];            // 유찰 횟수 구간 시작값 (0,1,2,3,4,5,6~9,10+)
const RB = [0, 30, 40, 50, 60, 70, 80, 90, 100, 110, 130]; // 낙찰가율 구간 시작값 (%)

const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[,\s%]/g, "")); return Number.isFinite(n) ? n : null; };
const digits = v => String(v || "").replace(/\D/g, "");
const kst = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const bucketIdx = (arr, v) => { let i = 0; while (i + 1 < arr.length && v >= arr[i + 1]) i++; return i; };

// 응답 항목 이름을 문서로 확인할 수 없어 후보·패턴으로 찾는다 (찾은 이름은 market.json의 fields에 기록)
const FIELD = {
  no: [/^cltrMngNo$/i],
  date: [/^opbdDt/i, /opbd.*(dt|dtm|de)$/i, /opbd/i],
  status: [/^pbctStatNm$/i, /StatNm$/i],
  statusCd: [/^pbctStatCd$/i, /StatCd$/i],
  apsl: [/^apslEvlAmt$/i, /apsl/i],
  minp: [/^lowstBidPrc$/i, /lowstBidPrc/i, /lowst/i],
  win: [/^(scsbd|sccbd|scbd)(Amt|Prc)/i, /(scsbd|sccbd|scbd|sucs).*(amt|prc)/i, /bidAmt$/i],
  rate: [/^(scsbd|sccbd|scbd).*(Rt|Rate)$/i, /(scsbd|sccbd|scbd).*(rt|rate)/i],
  bidders: [/^(vld|valid)/i, /vld.*(cnt|nmpr|num|co)/i],
  fails: [/^usbdNft$/i, /usbd/i],
  sd: [/^lctnSdnm$/i], sgg: [/^lctnSggnm$/i],
  usgM: [/^cltrUsgMclsCtgrNm$/i], usgS: [/^cltrUsgSclsCtgrNm$/i],
  name: [/^onbidCltrNm$/i, /CltrNm$/i],
  method: [/^dspsMthodNm$/i]
};
function findFields(sample) {
  const keys = Object.keys(sample || {}), out = {};
  for (const [f, pats] of Object.entries(FIELD)) {
    for (const p of pats) { const k = keys.find(k => p.test(k) && !(f === "win" && /rt$|rate/i.test(k)) && !(f === "bidders" && /invld|nvld/i.test(k))); if (k) { out[f] = k; break; } }
  }
  return out;
}

function parse(text) {
  const t = text.trim();
  if (t.startsWith("<")) {
    const m = t.match(/<returnAuthMsg>([^<]*)/)?.[1] || t.match(/<resultMsg>([^<]*)/)?.[1] || t.slice(0, 120);
    if (/NO_?DATA/i.test(m)) return { items: [], total: 0 };
    throw new Error(m);
  }
  const j = JSON.parse(t), d = j?.response ?? j;
  const h = d?.header || d?.result || {};
  const rc = String(h.resultCode ?? "00"), msg = String(h.resultMsg ?? "");
  if (rc === "03" || /NODATA/i.test(msg)) return { items: [], total: 0 };
  if (!["00", "0", "000", ""].includes(rc)) throw new Error(`${rc} ${msg}`);
  let items = d?.body?.items ?? [];
  if (items && !Array.isArray(items)) items = items.item ?? [];
  if (items && !Array.isArray(items)) items = [items];
  return { items: items.filter(i => i && typeof i === "object"), total: num(d?.body?.totalCount) };
}

export async function buildMarket(rawKey, { readJson, writeJson, nowKST, log = console.log }) {
  const key = normKey(rawKey);
  const prev = await readJson("market.json", null);
  const months = prev?.months || {};                 // "YYYYMM" → { "시도|cat": bucket }
  let op = prev?.op || null, fields = null, sample = prev?.sample || null, calls = 0;
  const errors = [];

  async function call(params) {
    const tryOps = op ? [op] : OPS;
    const errs = [];
    for (const o of tryOps) {
      const u = new URL(`${BASE}/${o}`);
      Object.entries({ serviceKey: key, resultType: "json", cltrTypeCd: "0001", prptDivCd: PRPT, dspsMthodCd: "0001", ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
      calls++;
      try {
        const res = await fetch(u.href);
        const text = await res.text();
        if (res.status === 404 || /API not found|Unexpected errors/i.test(text.slice(0, 200))) { errs.push(`${o}: HTTP ${res.status}`); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
        const r = parse(text);
        op = o; return r;
      } catch (e) { errs.push(`${o}: ${e.message}`); if (op) break; }
    }
    throw new Error(errs.join(" | ") || "호출 실패");
  }

  // 한 달(또는 기간) 전체 행 받기
  async function fetchRange(from, to) {
    const rows = [];
    for (let page = 1; page <= 200; page++) {
      if (calls >= MAX_CALLS) throw new Error(`호출 한도 ${MAX_CALLS}회 도달`);
      const { items, total } = await call({ pageNo: page, numOfRows: ROWS, opbdDtStart: from, opbdDtEnd: to });
      rows.push(...items);
      if (items.length < ROWS || (total != null && rows.length >= total)) break;
    }
    return rows;
  }

  function aggregate(rows) {
    if (rows.length && !fields) { fields = findFields(rows[0]); sample = rows[0]; }
    const F = fields || {}, g = r => k => (F[k] ? r[F[k]] : undefined);
    const byMonth = {}, seen = new Set(), recent = [];
    for (const r of rows) {
      const v = g(r);
      const date = digits(v("date")).slice(0, 8);
      if (date.length < 8) continue;
      const id = `${v("no")}|${date}|${r.pbctCdtnNo ?? ""}`;
      if (seen.has(id)) continue; seen.add(id);
      const st = String(v("status") || ""), cd = String(v("statusCd") || "");
      const won = cd === "0010" || /낙찰/.test(st), failed = cd === "0011" || /유찰/.test(st);
      if (!won && !failed) continue;
      const sido = sidoOf(v("sd"), "") || "기타";
      const cat = categoryOf(v("usgM"), v("usgS"), v("name")) || "etc";
      const apsl = num(v("apsl")), minp = num(v("minp")), win = num(v("win")), fails = num(v("fails")) ?? 0;
      let rate = num(v("rate"));
      if ((rate == null || rate <= 0) && win && apsl) rate = win / apsl * 100;
      const b = ((byMonth[date.slice(0, 6)] ||= {})[`${sido}|${cat}`] ||= { a: 0, f: 0, r: 0, rn: 0, m: 0, b: 0, bn: 0, fr: FB.map(() => [0, 0]), h: RB.map(() => 0) });
      if (failed) { b.f++; continue; }
      b.a++;
      const bidders = num(v("bidders"));
      if (bidders != null) { b.b += bidders; b.bn++; }
      if (rate != null && rate >= 10 && rate <= 300) {
        b.r += rate; b.rn++; b.h[bucketIdx(RB, rate)]++;
        const fi = bucketIdx(FB, fails); b.fr[fi][0]++; b.fr[fi][1] += rate;
        if (win && minp) b.m += win / minp * 100;       // 최저가 대비 낙찰가 (rn과 같은 개수 기준)
      }
      recent.push({ d: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, t: String(v("name") || "").slice(0, 60), sido, sgg: String(v("sgg") || ""), cat, apsl, win, rate: rate == null ? null : Math.round(rate * 10) / 10, n: bidders, fails });
    }
    for (const m of Object.values(byMonth)) for (const b of Object.values(m)) { b.r = Math.round(b.r * 10) / 10; b.m = Math.round(b.m * 10) / 10; b.fr = b.fr.map(([n, s]) => [n, Math.round(s * 10) / 10]); }
    return { byMonth, recent };
  }

  const today = kst(), y = kst(Date.now() - 864e5);
  const ym = (d, back) => { const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1 - back, 1)); return dt.toISOString().slice(0, 7).replace("-", ""); };
  const lastDay = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(4, 6), 0)).toISOString().slice(0, 10).replace(/-/g, "");
  const want = [...Array(MONTHS)].map((_, i) => ym(today, i));       // 이번 달부터 거꾸로 12개월
  const refresh = new Set(want.slice(0, 2));                        // 이번 달·지난달은 매일 새로
  let recentAll = [];

  for (const m of want) {
    if (!refresh.has(m) && months[m]) continue;
    const from = m + "01", to = refresh.has(m) && m === want[0] ? y : lastDay(m);
    if (from > to) { months[m] = months[m] || {}; continue; }
    try {
      const rows = await fetchRange(from, to);
      const { byMonth, recent } = aggregate(rows);
      months[m] = byMonth[m] || {};
      if (refresh.has(m)) recentAll.push(...recent);
      log(`  입찰결과 ${m}: ${rows.length}행 (호출 누적 ${calls})`);
      if (!rows.length && !fields) errors.push(`${m}: 결과 0건`);
    } catch (e) { errors.push(`${m}: ${e.message}`); if (/한도|SERVICE_KEY|NOT_REGISTERED|등록되지|LIMITED/i.test(e.message)) break; }
  }
  for (const k of Object.keys(months)) if (!want.includes(k)) delete months[k];

  recentAll.sort((a, b) => b.d.localeCompare(a.d));
  const out = {
    source: "한국자산관리공사 온비드 입찰결과 (공공데이터포털)", updatedAt: nowKST(), op, fields: fields || prev?.fields || null, sample,
    fb: FB, rb: RB, cats: CATS, months,
    recent: recentAll.length ? recentAll.filter(r => r.rate != null).slice(0, 400) : (prev?.recent || []),
    calls, errors
  };
  await writeJson("market.json", out, true);
  log(`market.json: ${Object.keys(months).length}개월, 호출 ${calls}회${errors.length ? ", 오류 " + errors.slice(0, 3).join(" / ") : ""}`);
  if (!op) throw new Error("입찰결과 API 주소를 찾지 못했어요: " + errors.slice(0, 2).join(" / "));
}
