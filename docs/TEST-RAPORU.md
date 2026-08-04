# WPAI doğrulama raporu

Bu dosya final CI sonuçlarıyla aynı commit üzerinde güncellenen kanıt indeksidir.

- 500 maddelik şartname matrisi: `docs/SPEC-500-EVIDENCE.json`
- Statik/migration doğrulaması: `npm run validate`
- Strict TypeScript: `npm run typecheck`
- Unit testleri: `npm run test:unit`
- Workerd/D1/R2/Queue testleri: `npm run test:worker`
- React production build: `npm run build`
- Wrangler production dry-run: `npm run deploy:dry`
- FAISS sidecar: `python -m pytest -q sidecar/test_faiss_service.py`
- Responsive ve çevrimdışı tarayıcı testleri: `.github/workflows/e2e-live-scenarios.yml`
- Gerçek Windows NSIS kurulum/kaldırma ve PE GUI testi: `.github/workflows/windows-desktop.yml`

Final artifact SHA, test sayıları, canlı `/health`, deployment/version ID ve dış bağımlılık durumu final teslim raporunda commit SHA ile birlikte yazılır. Eski commit sonuçları güncel head için kanıt sayılmaz.
