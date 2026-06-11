공장용 STEP 견적 계산기 - OCCT strict 버전

핵심 수정:
- 실제 occt-import-js ReadStepFile 결과의 root/meshes를 사용합니다.
- STEP 파싱 실패 시 가짜 UNNAMED_PART 견적을 만들지 않습니다.
- 어셈블리/서브어셈블리 컨테이너는 제외하고 실제 mesh가 있는 말단 파트만 표에 올립니다.
- 파트 행 클릭 시 해당 파트 mesh만 Three.js 뷰어에 표시합니다.
- 절곡은 이름만 보고 넣지 않습니다. 얇은 판재형 + 실제 곡면/R 후보가 있을 때만 자동 카운트합니다.
- 불확실한 절곡은 0회로 두고 공장이 직접 수정하도록 했습니다.
- 파이프/튜브/각관은 구매품 우선입니다.
- CNC는 구매품/프로파일/선반/판금 후보를 제외한 뒤 절삭 특징이 있을 때만 추천합니다.

실행:
1) GitHub Pages에 올리거나
2) 로컬 폴더에서 python -m http.server 8080 실행 후 http://localhost:8080 접속

주의:
- 실제 STEP 뷰어는 occt-import-js와 three.js CDN을 사용합니다. 인터넷 연결이 필요합니다.
- GitHub Pages에 올릴 때 저장소는 Public이어야 합니다.
