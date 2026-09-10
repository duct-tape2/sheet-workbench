"""Small xlwings bridge: it owns a fresh, invisible Excel process only."""
import json
import os
import sys


def emit(value):
    sys.stdout.write(json.dumps(value))
    sys.stdout.flush()


def error_code(error):
    """Return a redacted, stable diagnostic — never exception text or paths."""
    hresult = getattr(error, "hresult", None)
    if isinstance(hresult, int):
        return "HRESULT_{:08X}".format(hresult & 0xFFFFFFFF)
    name = type(error).__name__
    return "".join(character for character in name if character.isalnum() or character == "_")[:64] or "UnknownError"


def probe():
    try:
        import xlwings  # noqa: F401
    except Exception:
        emit({"xlwings": False, "excel": False})
        return 1
    # Deliberately do not instantiate Excel for the availability probe. A
    # registered executable is an availability signal only; the smoke script
    # establishes actual native-open evidence separately.
    excel_path = None
    try:
        import winreg

        for hive, flags in ((winreg.HKEY_LOCAL_MACHINE, 0), (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY)):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\EXCEL.EXE", 0, winreg.KEY_READ | flags) as key:
                    candidate, _ = winreg.QueryValueEx(key, None)
                    if isinstance(candidate, str) and os.path.isfile(candidate):
                        excel_path = candidate
                        break
            except OSError:
                continue
    except Exception:
        excel_path = None
    emit({"xlwings": True, "excel": bool(excel_path)})
    return 0


def write_owner(owner_path, owner_token, app):
    if not owner_path or not owner_token:
        return
    try:
        import ctypes

        process_id = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(app.api.Hwnd, ctypes.byref(process_id))
        with open(owner_path, "w", encoding="utf-8") as handle:
            json.dump({"pid": process_id.value, "parent": os.getpid(), "token": owner_token}, handle)
    except Exception:
        # Timeout cleanup will leave this operation alone rather than risking a
        # process it cannot prove it owns.
        pass


def recalculate(file_path, owner_path=None, owner_token=None):
    import xlwings as xw

    app = None
    book = None
    phase = "create_app"
    try:
        app = xw.App(visible=False, add_book=False)
        phase = "configure_app"
        app.display_alerts = False
        app.enable_events = False
        app.screen_updating = False
        # msoAutomationSecurityForceDisable. Set before either open to prevent
        # workbook macros, events, and external-link prompts from running.
        app.api.AutomationSecurity = 3
        app.api.EnableEvents = False
        app.api.AskToUpdateLinks = False
        phase = "record_owner"
        write_owner(owner_path, owner_token, app)
        phase = "open_write"
        book = app.books.open(
            file_path,
            update_links=False,
            read_only=False,
            ignore_read_only_recommended=True,
            notify=False,
        )
        # No Refresh/RefreshAll is called. Unsupported connection-bearing
        # packages were rejected by TypeScript before this bridge is reached.
        # Rebuild formula dependencies before saving; a plain Calculate can
        # leave a manual-calculation workbook's cached values stale.
        phase = "calculate_full_rebuild"
        app.api.CalculateFullRebuild()
        phase = "calculate"
        app.calculate()
        phase = "save"
        book.save()
        phase = "close_write"
        book.close()
        book = None
        # Reopen after save in the same isolated application; this is an
        # explicit native reopen boundary before TypeScript compares the ZIP.
        phase = "reopen_readonly"
        book = app.books.open(
            file_path,
            update_links=False,
            read_only=True,
            ignore_read_only_recommended=True,
            notify=False,
        )
        phase = "close_readonly"
        book.close()
        book = None
        emit({"ok": True, "phase": "complete"})
        return 0
    except Exception as error:
        emit({"ok": False, "phase": phase, "errorCode": error_code(error)})
        return 1
    finally:
        if book is not None:
            try:
                book.close()
            except Exception:
                pass
        if app is not None:
            try:
                app.quit()
            except Exception:
                pass


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        raise SystemExit(probe())
    if len(sys.argv) in (3, 7) and sys.argv[1] == "--recalculate":
        if len(sys.argv) == 7 and sys.argv[3] == "--owner-file" and sys.argv[5] == "--owner-token":
            raise SystemExit(recalculate(sys.argv[2], sys.argv[4], sys.argv[6]))
        if len(sys.argv) == 3:
            raise SystemExit(recalculate(sys.argv[2]))
    emit({"ok": False})
    raise SystemExit(2)
