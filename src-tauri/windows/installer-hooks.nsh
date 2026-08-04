!include "FileFunc.nsh"

!macro NSIS_HOOK_PREUNINSTALL
  ${GetParameters} $R0
  ${GetOptions} $R0 "/PURGELOCALCACHE" $R1
  IfErrors wpai_prompt_cache_cleanup wpai_purge_local_cache

  wpai_prompt_cache_cleanup:
    IfSilent wpai_keep_local_cache
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 \
      "Bu bilgisayardaki Yerel Eğitim İndeksi ve geçici Cloudflare kurulum önbelleği de silinsin mi? Buluttaki müşteri verileri silinmez." \
      IDYES wpai_purge_local_cache IDNO wpai_keep_local_cache

  wpai_purge_local_cache:
    RMDir /r "$APPDATA\com.wpai.desktop\faiss-index"
    RMDir /r "$APPDATA\com.wpai.desktop\cloudflare-bootstrap"
    RMDir /r "$LOCALAPPDATA\com.wpai.desktop\faiss-index"
    RMDir /r "$LOCALAPPDATA\com.wpai.desktop\cloudflare-bootstrap"

  wpai_keep_local_cache:
!macroend
