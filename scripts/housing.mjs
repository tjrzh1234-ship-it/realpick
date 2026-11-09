// 분양·임대 공고 → housing.json
// 1) 한국부동산원 청약홈 분양정보 조회 서비스 (아파트 / 오피스텔·도시형·민간임대 / 무순위·잔여세대)
//    https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/...   (공공데이터포털 '한국부동산원_청약홈 분양정보 조회 서비스' 활용신청)
// 2) LH 분양·임대 공고 (한국토지주택공사_분양임대공고문 조회 서비스)
//    https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1
// 인증키: DATA_GO_KR_KEY (공매와 같은 키)

const ODC = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/";
const APPLYHOME_OPS = [
  ["getAPTLttotPblancDetail", "아파트 분양"],
  ["getUrbtyOfctlLttotPblancDetail", "오피스텔·도시형·민간임대"],
  ["getRemndrLttotPblancDetail", "무순위·잔여세대"]
];
const APPLYHOME_MDL = { getAPTLttotPblancDetail: "getAPTLttotPblancMdl", getUrbtyOfctlLttotPblancDetail: "getUrbtyOfctlLttotPblancMdl", getRemndrLttotPblancDetail: "getRemndrLttotPblancMdl" };
const LH_URLS = [
  "https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1",
  "http://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1"
];

const SIDO_MAP = [["서울","서울"],["부산","부산"],["대구","대구"],["인천","인천"],["광주","광주"],["대전","대전"],["울산","울산"],["세종","세종"],["경기","경기"],["강원","강원"],["충청북","충북"],["충북","충북"],["충청남","충남"],["충남","충남"],["전북","전북"],["전라북","전북"],["전남","전남"],["전라남","전남"],["경상북","경북"],["경북","경북"],["경상남","경남"],["경남","경남"],["제주","제주"]];
const sidoOf = a => { const s = String(a || "").trim(); for (const [k, v] of SIDO_MAP) if (s.startsWith(k)) return v; return ""; };
const d10 = s => { const m = String(s || "").match(/(\d{4})[-.\/]?(\d{2})[-.\/]?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const ym = s => { const m = String(s || "").match(/(\d{4})[-.\/]?(\d{2})/); return m ? `${m[1]}-${m[2]}` : null; };
const pick = (o, ...ks) => { for (const k of ks) { const v = o?.[k] ?? o?.[k.toLowerCase()]; if (v != null && v !== "") return v; } return null; };
const mask = u => u.replace(/serviceKey=[^&]+/i, "serviceKey=***");

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!res.ok || !j) throw new Error(`HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
  return j;
}

/* ── 청약홈 ── */
async function applyhome(key, fromDate, log) {
  const out = [];
  for (const [op, label] of APPLYHOME_OPS) {
    const rows = [];
    try {
      for (let page = 1; page <= 10; page++) {
        const url = `${ODC}${op}?page=${page}&perPage=200&serviceKey=${encodeURIComponent(key)}&cond%5BRCRIT_PBLANC_DE%3A%3AGTE%5D=${fromDate}`;
        const j = await getJson(url);
        const data = j.data || [];
        rows.push(...data);
        if (data.length < 200) break;
      }
    } catch (e) { log.push(`청약홈 ${label}: ${e.message}`); continue; }

    // 주택형별 분양가·면적 — 아직 접수 중이거나 곧 접수하는 공고만 (공고마다 1번 호출, 최대 150번)
    const price = {};
    const cutDay = new Date(Date.now() + 9 * 3600e3 - 30 * 864e5).toISOString().slice(0, 10);
    const targets = [...new Set(rows.filter(r => (d10(r.SUBSCRPT_RCEPT_ENDDE || r.RCEPT_ENDDE || r.PRZWNER_PRESNATN_DE) || "9999") >= cutDay).map(r => String(r.HOUSE_MANAGE_NO)))].slice(0, 150);
    let mdlErr = 0;
    for (const id of targets) {
      try {
        const j = await getJson(`${ODC}${APPLYHOME_MDL[op]}?page=1&perPage=100&serviceKey=${encodeURIComponent(key)}&cond%5BHOUSE_MANAGE_NO%3A%3AEQ%5D=${encodeURIComponent(id)}`);
        for (const m of j.data || []) {
          const amt = +(m.LTTOT_TOP_AMOUNT || m.SUPLY_AMOUNT || 0);
          const ar = +(m.SUPLY_AR || m.EXCLUSE_AR || 0);
          const p = price[id] || (price[id] = { min: null, max: null, arMin: null, arMax: null });
          if (amt > 0) { p.min = p.min == null ? amt : Math.min(p.min, amt); p.max = p.max == null ? amt : Math.max(p.max, amt); }
          if (ar > 0) { p.arMin = p.arMin == null ? ar : Math.min(p.arMin, ar); p.arMax = p.arMax == null ? ar : Math.max(p.arMax, ar); }
        }
      } catch (e) { if (++mdlErr === 1) log.push(`청약홈 ${label} 분양가: ${e.message}`); if (mdlErr >= 5) break; }
    }

    for (const r of rows) {
      const id = String(r.HOUSE_MANAGE_NO || ""); const pb = String(r.PBLANC_NO || "");
      if (!id) continue;
      const addr = String(r.HSSPLY_ADRES || "").trim();
      const p = price[id];
      out.push({
        id: `ah-${id}-${pb}`, src: "청약홈", group: label,
        kind: r.HOUSE_DTL_SECD_NM || r.HOUSE_SECD_NM || label,
        name: String(r.HOUSE_NM || "").trim(), addr, sido: sidoOf(addr || r.SUBSCRPT_AREA_CODE_NM),
        org: r.BSNS_MBY_NM || r.CNSTRCT_ENTRPS_NM || "",
        households: +r.TOT_SUPLY_HSHLDCO || null,
        notice: d10(r.RCRIT_PBLANC_DE),
        start: d10(r.SUBSCRPT_RCEPT_BGNDE || r.RCEPT_BGNDE || r.GNRL_RNK1_CRSPAREA_RCPTDE || r.SPSPLY_RCEPT_BGNDE),
        end: d10(r.SUBSCRPT_RCEPT_ENDDE || r.RCEPT_ENDDE || r.GNRL_RNK2_ETC_AREA_ENDDE || r.GNRL_RNK1_ETC_AREA_ENDDE),
        winner: d10(r.PRZWNER_PRESNATN_DE), moveIn: ym(r.MVN_PREARNGE_YM),
        priceMin: p?.min ?? null, priceMax: p?.max ?? null, arMin: p?.arMin ?? null, arMax: p?.arMax ?? null,
        tel: r.MDHS_TELNO || "",
        url: /^https?:\/\//.test(r.PBLANC_URL || "") ? r.PBLANC_URL : (/^https?:\/\//.test(r.HMPG_ADRES || "") ? r.HMPG_ADRES : "https://www.applyhome.co.kr")
      });
    }
    log.push(`청약홈 ${label}: ${rows.length}건`);
  }
  return out;
}

/* ── LH ── */
function lhRows(j) {
  // 응답은 [ {dsSch:[…]}, {dsList:[…], resHeader:[…]} ] 같은 배열 모양
  const found = [];
  const walk = x => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (Array.isArray(x.dsList)) found.push(...x.dsList);
    for (const v of Object.values(x)) if (v && typeof v === "object" && !Array.isArray(v?.dsList)) walk(v);
  };
  walk(j);
  return found;
}
async function lh(key, log) {
  const today = new Date(Date.now() + 9 * 3600e3);
  const fmt = (d, sep) => d.toISOString().slice(0, 10).replace(/-/g, sep);
  const from = new Date(today - 120 * 864e5), to = new Date(+today + 365 * 864e5);
  const out = []; let lastErr = "";
  for (const upp of ["05", "06", "01", "22"]) {          // 분양주택, 임대주택, 토지, 상가
    let rows = null;
    for (const base of LH_URLS) {
      for (const sep of ["", "."]) {
        const url = `${base}?serviceKey=${encodeURIComponent(key)}&PG_SZ=500&PAGE=1&UPP_AIS_TP_CD=${upp}&PAN_NT_ST_DT=${fmt(from, sep)}&CLSG_DT=${fmt(to, sep)}`;
        try {
          const j = await getJson(url);
          const r = lhRows(j);
          const hdr = JSON.stringify(j).match(/"SS_CODE"\s*:\s*"([^"]+)"[^}]*?"RS_DTTM"|"(?:resultMsg|RS_MSG)"\s*:\s*"([^"]+)"/);
          if (r.length || /"SS_CODE"\s*:\s*"Y"/.test(JSON.stringify(j))) { rows = r; break; }
          lastErr = hdr ? (hdr[1] || hdr[2]) : JSON.stringify(j).slice(0, 160);
        } catch (e) { lastErr = e.message; }
      }
      if (rows) break;
    }
    if (!rows) { log.push(`LH(${upp}): ${lastErr}`); if (/SERVICE_KEY|NOT_REGISTERED|NO_OPENAPI|등록되지/.test(lastErr)) break; continue; }
    for (const r of rows) {
      const id = pick(r, "PAN_ID"); if (!id) continue;
      const region = String(pick(r, "CNP_CD_NM") || "").trim();
      out.push({
        id: `lh-${id}`, src: "LH", group: pick(r, "UPP_AIS_TP_NM") || ({ "05": "분양주택", "06": "임대주택", "01": "토지", "22": "상가" }[upp]),
        kind: pick(r, "AIS_TP_CD_NM") || "", name: String(pick(r, "PAN_NM") || "").trim(),
        addr: "", region, sido: sidoOf(region),
        org: "한국토지주택공사(LH)", status: pick(r, "PAN_SS") || "",
        notice: d10(pick(r, "PAN_NT_ST_DT", "PAN_DT")), start: null, end: d10(pick(r, "CLSG_DT")),
        url: /^https?:\/\//.test(pick(r, "DTL_URL") || "") ? pick(r, "DTL_URL") : "https://apply.lh.or.kr"
      });
    }
    log.push(`LH ${upp}: ${rows.length}건`);
  }
  return out;
}

export async function buildHousing(key, { readJson, writeJson, nowKST }) {
  const prev = await readJson("housing.json", { items: [] });
  const prevGeo = new Map((prev.items || []).filter(i => i.la).map(i => [i.id, [i.la, i.lo, i.geo]]));
  const today = nowKST().slice(0, 10);
  const from = new Date(Date.now() + 9 * 3600e3 - 150 * 864e5).toISOString().slice(0, 10);
  const log = [];
  const a = await applyhome(key, from, log).catch(e => { log.push("청약홈: " + e.message); return []; });
  const b = await lh(key, log).catch(e => { log.push("LH: " + e.message); return []; });
  let items = [...a, ...b];
  if (!items.length) {
    console.log("housing.json: 받은 공고가 없어 기존 파일을 둡니다 → " + log.join(" / ")
      + "\n  (공공데이터포털에서 '한국부동산원_청약홈 분양정보 조회 서비스'와 '한국토지주택공사_분양임대공고문 조회 서비스' 활용신청을 확인하세요)");
    return;
  }
  // 접수가 끝난 지 30일 지난 공고는 뺀다
  const cut = new Date(Date.parse(today) - 30 * 864e5).toISOString().slice(0, 10);
  const seen = new Set();
  items = items.filter(i => {
    if (seen.has(i.id)) return false; seen.add(i.id);
    const last = i.end || i.winner || i.notice; return !last || last >= cut;
  });
  for (const i of items) { const g = prevGeo.get(i.id); if (g) [i.la, i.lo, i.geo] = g; }
  items.sort((x, y) => (y.notice || "").localeCompare(x.notice || ""));
  await writeJson("housing.json", {
    source: "한국부동산원 청약홈 · 한국토지주택공사(LH) (공공데이터포털)",
    updatedAt: nowKST(), items
  }, true);
  console.log(`housing.json: ${items.length}건 저장 (${log.join(", ")})`);
}
