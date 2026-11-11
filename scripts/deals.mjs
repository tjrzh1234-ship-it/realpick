// 메인 '이번 주 실거래' 칸: 아파트 실거래 중 최근 거래가 직전 1년 최고가를 넘은 것, 지역별 최근 거래 수
// - 공매 시세 비교 때 받아 둔 rtms-cache.json (아파트, 시·군·구별 최근 12개월)을 그대로 쓴다 → 추가 API 호출 없음
// - 범위: 공매 아파트 물건이 있는 시·군·구 (전국 전체가 아님). 화면에 기준을 함께 적는다.
// rtms-cache 행: [동, 전용㎡, 금액(만원), 단지명, 거래일 YYYY-MM-DD]
import { readFile } from "node:fs/promises";

const RECENT_DAYS = 14;      // 실거래 신고는 계약 후 30일 안에 하므로 '최근 2주 계약' 기준
export async function buildDeals({ readJson, writeJson, nowKST }) {
  const cache = await readJson("rtms-cache.json", null);
  if (!cache?.entries) return console.log("실거래: rtms-cache.json 없음 (공매 작업 뒤에 실행)");
  const sgg = JSON.parse(await readFile(new URL("./sgg-codes.json", import.meta.url), "utf8"));
  const nameOf = Object.fromEntries(Object.entries(sgg).map(([n, c]) => [c, n]));
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const since = new Date(Date.now() + 9 * 3600e3 - RECENT_DAYS * 864e5).toISOString().slice(0, 10);

  const bySgg = new Map();   // sggCd -> rows
  for (const [k, e] of Object.entries(cache.entries)) {
    const [cat, code] = k.split(":");
    if (cat !== "apt" || !e?.rows?.length) continue;
    if (!bySgg.has(code)) bySgg.set(code, []);
    bySgg.get(code).push(...e.rows);
  }
  const top = [], regions = [];
  for (const [code, rows] of bySgg) {
    const name = nameOf[code] || code;
    const recent = rows.filter(r => r[4] >= since && r[4] <= today);
    if (recent.length) regions.push({ name, n: recent.length });
    // 같은 단지·같은 면적(소수점 버림)끼리 비교
    const groups = new Map();
    for (const r of rows) {
      const g = `${r[0]}|${r[3]}|${Math.floor(r[1])}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    for (const list of groups.values()) {
      const news = list.filter(r => r[4] >= since);
      const olds = list.filter(r => r[4] < since);
      if (!news.length || olds.length < 2) continue;       // 비교할 과거 거래가 2건 이상일 때만
      const prev = Math.max(...olds.map(r => r[2]));
      const best = news.reduce((a, b) => (b[2] > a[2] ? b : a));
      if (best[2] <= prev) continue;
      top.push({ name: best[3] || "(단지명 없음)", region: name, umd: best[0], area: best[1], price: best[2], prev, up: best[2] - prev, day: best[4] });
    }
  }
  top.sort((a, b) => b.price - a.price);
  regions.sort((a, b) => b.n - a.n);
  await writeJson("deals.json", {
    updatedAt: nowKST(),
    basis: `최근 ${RECENT_DAYS}일 계약된 아파트 거래 · 같은 단지·같은 면적의 직전 1년 최고가와 비교 · 공매 물건이 있는 ${bySgg.size}개 시·군·구 기준`,
    top: top.slice(0, 20), regions: regions.slice(0, 10)
  });
  console.log(`실거래: 시·군·구 ${bySgg.size}곳, 최고가 갱신 ${top.length}건, 최근 거래 ${regions.reduce((s, r) => s + r.n, 0)}건`);
}
