# WPAI kalite kapıları

Bu dal aşağıdaki kapıların tamamı yeşil olmadan `main` dalına birleştirilmez:

1. Secret taraması
2. Cloudflare manifesti ve D1 migration doğrulaması
3. Ayrı frontend, Worker ve Workerd test TypeScript projeleri
4. Node unit testleri
5. Gerçek Workerd + D1 integration testleri
6. React production build
7. Wrangler production dry-run
8. npm yüksek seviye güvenlik denetimi
9. Linux FAISS testleri
10. Windows FAISS sidecar derlemesi
11. Rust compile kontrolü
12. Gerçek Tauri NSIS `setup.exe` üretimi

Test beklentileri hatayı gizlemek için gevşetilmez. Davranış bozuksa kaynak kod düzeltilir ve aynı test yeniden çalıştırılır.
