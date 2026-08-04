from pathlib import Path

path = Path(__file__).resolve().parent / "apply_login_reliability_patch.py"
value = path.read_text("utf-8")
old = '''    replace_once(
        "tests/worker/auth.test.ts",
        "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'YeniGüvenliParola456', revokeOtherSessions: true })",
        "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: '654321', revokeOtherSessions: true })",
    )'''
new = '''    auth_tests = read("tests/worker/auth.test.ts")
    old_password_payload = "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'YeniGüvenliParola456', revokeOtherSessions: true })"
    if auth_tests.count(old_password_payload) != 2:
        raise RuntimeError(f"Expected two password-change payloads, found {auth_tests.count(old_password_payload)}")
    write("tests/worker/auth.test.ts", auth_tests.replace(old_password_payload, "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: '654321', revokeOtherSessions: true })"))'''
if value.count(old) != 1:
    raise RuntimeError(f"Expected one patch block, found {value.count(old)}")
path.write_text(value.replace(old, new, 1), "utf-8")
print("Login patch source prepared.")
