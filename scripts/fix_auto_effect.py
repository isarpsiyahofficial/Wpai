from pathlib import Path

p = Path('src/frontend/App.tsx')
text = p.read_text('utf-8')
old = """  useEffect(() => {
    if (!online || autoAttempted) return;
    setAutoAttempted(true);
    const timer = window.setTimeout(() => { void retryAutomaticConnection(); }, 100);
    return () => window.clearTimeout(timer);
  }, [autoAttempted, online]);
"""
new = """  useEffect(() => {
    if (!online || autoAttempted) return;
    setAutoAttempted(true);
    void retryAutomaticConnection();
  }, [autoAttempted, online]);
"""
if old not in text:
    raise SystemExit('automatic connection effect anchor missing')
p.write_text(text.replace(old, new, 1), 'utf-8')
