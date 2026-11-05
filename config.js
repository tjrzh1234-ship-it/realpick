// 리얼픽 서버 연결 설정
// Supabase → Project Settings → API 화면의 값 두 개를 따옴표 안에 붙여넣으세요.
// (anon public key는 공개용 키라 이 파일이 공개돼도 괜찮습니다. service_role 키는 절대 넣지 마세요.)
window.REALPICK_CONFIG = {
  supabaseUrl: "https://yyfpkwxqgmwqslsdbilf.supabase.co",
  supabaseAnonKey: "sb_publishable_vMl1gxyignZdxLbaTlndLw_UEKt2f6-",

  // 사업자 정보: 사업자등록·통신판매업 신고 후 채우면 사이트 아래쪽과 약관에 자동으로 표시됩니다.
  company: {
    name: "",          // 상호 (예: 주식회사 ○○)
    ceo: "",           // 대표자
    bizNo: "",         // 사업자등록번호
    mailOrderNo: "",   // 통신판매업 신고번호
    address: "",       // 사업장 주소
    email: "",         // 고객 문의 이메일
    phone: "",         // 고객센터 전화
    privacyOfficer: "" // 개인정보 보호책임자 (이름 · 직책)
  }
};
