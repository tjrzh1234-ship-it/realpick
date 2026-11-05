// 리얼픽 데이터 자동 수집 스크립트
// - 기업마당 지원사업정보 API  → notices.json  (환경변수 BIZINFO_API_KEY)
// - 한국은행 ECOS Open API      → rates.json    (환경변수 ECOS_API_KEY)
// - 온비드 공매 + 국토부 실거래가 → auctions.json (환경변수 DATA_GO_KR_KEY, 공공데이터포털 인증키)
// - 정책브리핑 정책뉴스(부동산)  → insight.json  (DATA_GO_KR_KEY, AI 해설은 ANTHROPIC_API_KEY 있을 때만)
// 키가 없는 쪽은 건너뛰고, 기존 파일은 그대로 둔다. Node 18 이상, 외부 패키지 없음.
import { readFile, writeFile } from "node:fs/promises";
import { buildAuctions } from "./auctions.mjs";
import { buildInsight } from "./insight.mjs";

const ROOT = new URL("../", import.meta.url);
const nowKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00";
const todayKST = () => nowKST().slice(0, 10);

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, ROOT), "utf8")); } catch { return fallback; }
}
async function writeJson(name, data, compact = false) {
  await writeFile(new URL(name, ROOT), (compact ? JSON.stringify(data) : JSON.stringify(data, null, 1)) + "\n", "utf8");
}
async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/(crtfcKey=|\/api\/\w+\/)[^/&]+/, "$1***")}`);
  return res.json();
}

/* ───────────── 기업마당 ───────────── */
const SIDO = ["서울","부산","대구","인천","광주","대전","울산","세종","경기","강원","충북","충남","전북","전남","경북","경남","제주"];
const SIDO_LONG = {
  "서울특별시":"서울","부산광역시":"부산","대구광역시":"대구","인천광역시":"인천","광주광역시":"광주","대전광역시":"대전",
  "울산광역시":"울산","세종특별자치시":"세종","경기도":"경기","강원특별자치도":"강원","강원도":"강원","충청북도":"충북",
  "충청남도":"충남","전북특별자치도":"전북","전라북도":"전북","전라남도":"전남","경상북도":"경북","경상남도":"경남","제주특별자치도":"제주"
};
const REALMS = ["기술","경영","수출","내수","창업","인력","금융","기타"];

export function stripHtml(s = "") {
  return String(s).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
const ymd = raw => { const m = String(raw || "").match(/(\d{4})[-.]?(\d{2})[-.]?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

export function detectRegion(title, hashtags, insttText) {
  const head = title.match(/^\s*\[([^\]]+)\]/);
  if (head) {
    for (const part of head[1].split(/[·ㆍ,\/\s]+/)) {
      if (SIDO.includes(part)) return part;
      if (SIDO_LONG[part]) return SIDO_LONG[part];
      if (part.startsWith("전남광주")) return "광주";
    }
  }
  for (const t of hashtags) { if (SIDO.includes(t)) return t; if (t === "전남광주") return "광주"; }
  for (const [long, short] of Object.entries(SIDO_LONG)) if (insttText.includes(long)) return short;
  return "전국";
}

export function extractItems(body) {
  const ja = body?.jsonArray ?? body;
  if (Array.isArray(ja)) return ja;
  if (Array.isArray(ja?.item)) return ja.item;
  if (ja?.item && typeof ja.item === "object") return [ja.item];
  return [];
}

const absUrl = u => { try { return u ? new URL(String(u).trim(), "https://www.bizinfo.go.kr").href : null; } catch { return null; } };
// 첨부파일: 이름과 경로가 쉼표·@ 로 여러 개 이어질 수 있어 나눠서 짝을 맞춘다
function filesOf(it) {
  const out = [];
  const pair = (names, paths) => {
    const ns = String(names || "").split(/@|,(?=[^,]*\.\w{2,5}(?:,|$))/).map(s => s.trim()).filter(Boolean);
    const ps = String(paths || "").split(/@|,(?=https?:)/).map(s => s.trim()).filter(Boolean);
    ns.forEach((n, i) => out.push({ name: stripHtml(n), url: absUrl(ps[i]) }));
  };
  pair(it.printFileNm, it.printFlpthNm);
  pair(it.fileNm, it.flpthNm);
  const seen = new Set();
  return out.filter(f => f.name && !seen.has(f.name) && seen.add(f.name)).slice(0, 10);
}

export function normalizeNotice(it) {
  // 응답에는 같은 값이 두 이름으로 올 수 있다 (pblancId/seq, pblancNm/title, jrsdInsttNm/author 등)
  const id = it.pblancId || it.seq, title = stripHtml(it.pblancNm || it.title);
  if (!id || !title) return null;
  const hashtags = String(it.hashTags ?? it.hashtags ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const period = String(it.reqstBeginEndDe ?? it.reqstDt ?? "").split("~").map(s => s.trim());
  const begin = ymd(period[0]), end = ymd(period[1]);
  const created = ymd(it.creatPnttm || it.pubDate) || todayKST();
  const realmRaw = stripHtml(it.pldirSportRealmLclasCodeNm || it.lcategory);
  const jrsd = stripHtml(it.jrsdInsttNm || it.author);
  return {
    pblancId: id,
    pblancNm: title,
    pblancUrl: absUrl(it.pblancUrl || it.link),
    realm: REALMS.includes(realmRaw) ? realmRaw : (realmRaw || "기타"),
    region: detectRegion(title, hashtags, `${jrsd} ${it.excInsttNm || ""}`),
    jrsdInsttNm: jrsd || "-",
    excInsttNm: stripHtml(it.excInsttNm) || jrsd || "-",
    reqstBegin: begin || created,
    reqstEnd: end || begin || created,
    budgetBased: !end,              // 끝 날짜가 없으면 상시·예산 소진 시까지로 본다
    creatPnttm: created,
    trgetNm: stripHtml(it.trgetNm) || "중소기업",
    inqireCo: Number(it.inqireCo) || 0,
    bsnsSumryCn: stripHtml(it.bsnsSumryCn || it.description).slice(0, 600) || undefined,
    reqstMthPapersCn: stripHtml(it.reqstMthPapersCn) || undefined,
    refrncNm: stripHtml(it.refrncNm) || undefined,
    applyUrl: absUrl(it.rceptEngnHmpgUrl) || undefined,
    files: filesOf(it),
    hashtags
  };
}

async function updateNotices(key) {
  const url = new URL("https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do");
  url.searchParams.set("crtfcKey", key);
  url.searchParams.set("dataType", "json");
  url.searchParams.set("searchCnt", "500");
  const fresh = extractItems(await getJson(url.href)).map(normalizeNotice).filter(Boolean);
  if (!fresh.length) throw new Error("기업마당 응답에 공고가 없습니다. 키 또는 응답 형식을 확인하세요.");

  // 기존 목록과 합친 뒤, 마감 후 60일 지난 공고는 정리한다
  const prev = await readJson("notices.json", { items: [] });
  const byId = new Map(prev.items.map(n => [n.pblancId, n]));
  for (const n of fresh) byId.set(n.pblancId, { ...byId.get(n.pblancId), ...n });
  const cutoff = new Date(Date.parse(todayKST()) - 60 * 864e5).toISOString().slice(0, 10);
  const items = [...byId.values()]
    .filter(n => n.budgetBased || n.reqstEnd >= cutoff)
    .sort((a, b) => b.creatPnttm.localeCompare(a.creatPnttm))
    .slice(0, 1500);

  await writeJson("notices.json", { source: "기업마당 지원사업정보 Open API (bizinfo.go.kr)", updatedAt: nowKST(), items });
  console.log(`notices.json: 새로 받은 ${fresh.length}건, 저장 ${items.length}건`);
}

/* ───────────── 한국은행 ECOS ───────────── */
const ECOS = "https://ecos.bok.or.kr/api";
// 통계표 코드와 항목. code가 맞지 않으면 항목 이름(match)으로 다시 찾는다.
export const SERIES = [
  { key: "base",     label: "한국은행 기준금리",  stat: "722Y001", code: "0101000",      match: /기준금리/,       basis: "월말 기준" },
  { key: "credit",   label: "일반신용대출 금리",  stat: "121Y006", code: null,           match: /일반신용대출/,   basis: "예금은행 신규취급액 기준" },
  { key: "mortgage", label: "주택담보대출 금리",  stat: "121Y006", code: "BECBLA0302",   match: /주택담보대출/,   basis: "예금은행 신규취급액 기준" },
  { key: "jeonse",   label: "전세자금대출 금리",  stat: "121Y015", code: "BECBLB020210", match: /전세자금대출/,   basis: "예금은행 잔액 기준" }
];

async function findItemCode(key, s) {
  const body = await getJson(`${ECOS}/StatisticItemList/${key}/json/kr/1/200/${s.stat}`);
  const rows = body?.StatisticItemList?.row || [];
  const monthly = rows.filter(r => r.CYCLE === "M");
  const byCode = monthly.find(r => r.ITEM_CODE === s.code);
  if (byCode) return byCode.ITEM_CODE;
  const byName = monthly.find(r => s.match.test(r.ITEM_NAME));
  if (byName) return byName.ITEM_CODE;
  throw new Error(`${s.label}: ${s.stat}에서 항목을 찾지 못했습니다`);
}

function monthsBack(n) {
  const d = new Date(Date.parse(todayKST()));
  const end = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  d.setUTCMonth(d.getUTCMonth() - n);
  const start = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return [start, end];
}

async function updateRates(key) {
  const [start, end] = monthsBack(14);
  const series = [];
  for (const s of SERIES) {
    const item = await findItemCode(key, s);
    const body = await getJson(`${ECOS}/StatisticSearch/${key}/json/kr/1/100/${s.stat}/M/${start}/${end}/${item}`);
    if (body?.RESULT) throw new Error(`${s.label}: ${body.RESULT.CODE} ${body.RESULT.MESSAGE}`);
    const points = (body?.StatisticSearch?.row || [])
      .filter(r => r.DATA_VALUE !== "" && r.DATA_VALUE != null)
      .map(r => ({ t: `${r.TIME.slice(0, 4)}-${r.TIME.slice(4, 6)}`, v: Number(r.DATA_VALUE) }))
      .sort((a, b) => a.t.localeCompare(b.t));
    if (!points.length) throw new Error(`${s.label}: 데이터가 비어 있습니다`);
    series.push({ key: s.key, label: s.label, basis: s.basis, stat: s.stat, item, unit: "%", points });
  }
  await writeJson("rates.json", { source: "한국은행 경제통계시스템(ECOS)", updatedAt: nowKST(), series });
  console.log("rates.json: " + series.map(s => `${s.label} ${s.points.at(-1).t} ${s.points.at(-1).v}%`).join(", "));
}

/* ───────────── 실행 ───────────── */
if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  const tasks = [
    ["BIZINFO_API_KEY", "기업마당 공고", updateNotices],
    ["ECOS_API_KEY", "ECOS 금리", updateRates],
    ["DATA_GO_KR_KEY", "정책뉴스 인사이트", key => buildInsight(key, { readJson, writeJson, nowKST })],
    ["DATA_GO_KR_KEY", "온비드 공매·실거래 비교", key => buildAuctions(key, { readJson, writeJson, nowKST })]
  ];
  for (const [env, name, fn] of tasks) {
    const key = process.env[env];
    if (!key) { console.log(`${name}: ${env}가 없어 건너뜁니다`); continue; }
    try { await fn(key); } catch (e) { failed = true; console.error(`${name} 실패: ${e.message}`); }
  }
  if (failed) process.exitCode = 1;
}
