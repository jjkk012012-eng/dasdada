공장용 STEP 견적 계산기 - STEP 텍스트 파서 고정 버전

핵심 변경:
1. occt-import-js CDN 실패 때문에 STEP을 못 읽는 문제를 피하기 위해 순수 JavaScript STEP 텍스트 파서를 기본으로 사용합니다.
2. PRODUCT, PRODUCT_DEFINITION, NEXT_ASSEMBLY_USAGE_OCCURRENCE, MANIFOLD_SOLID_BREP를 읽습니다.
3. child가 있는 어셈블리/서브어셈블리는 견적 대상에서 제외하고, 하위가 없는 말단 파트만 표에 표시합니다.
4. 파이프/튜브/각관은 구매품 우선입니다.
5. 절곡은 이름만으로 막 잡지 않고, 얇은 판재형 + BEND/BENT/FOLD/FLANGE/L_BRACKET/U_BRACKET/절곡 힌트가 있을 때만 자동 절곡 후보를 넣습니다. 불확실하면 0회로 두고 공장이 직접 수정합니다.
6. CNC는 구매품, 프로파일, 선반, 판금/절곡을 먼저 제외한 뒤 남는 절삭 가공품으로 잡습니다.

주의:
- 이 버전은 STEP 파일을 안정적으로 읽어 파트명/수량/어셈블리 구조를 뽑는 데 초점을 둔 버전입니다.
- 실제 3D 형상 렌더링은 포함하지 않습니다. 런칭 때는 OpenCascade 서버 파서 또는 WASM 파서를 별도로 붙이는 것이 맞습니다.
- GitHub Pages에 바로 업로드 가능합니다.
