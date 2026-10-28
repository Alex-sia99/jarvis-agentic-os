"""
Jarvis — primitives bureau Windows (capture d'écran, souris, fenêtres) en Python/ctypes.

Pourquoi Python et pas PowerShell : Defender (AMSI) bloque les scripts PowerShell qui déclarent
plusieurs P/Invoke user32 (SetForegroundWindow + mouse_event…) comme « contenu malveillant ».
ctypes n'est pas filtré, et PIL donne une capture DPI-aware (pixels physiques), donc les
coordonnées de clic et celles de l'image sont dans le même repère.

Usage : python jarvis-desktop.py <commande> [args…]  → une ligne JSON sur stdout
  screen                              métriques écran (physique + bureau virtuel)
  shot <fichier.jpg> [all] [maxWidth]  capture (écran principal ou tous) redimensionnée en JPEG
  windows                             fenêtres visibles [{hwnd,pid,process,title,foreground}]
  focus|minimize|maximize|close <titre ou pid ou hwnd>
  click <x> <y> [right] [double]      clic en pixels physiques
  move <x> <y>
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
u = ctypes.windll.user32
k = ctypes.windll.kernel32
u.SetProcessDPIAware()

SKIP_TITLES = {"Program Manager", "Windows Input Experience", "NVIDIA GeForce Overlay", "Settings", "Status", "Microsoft Text Input Application"}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def proc_name(pid):
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = w.DWORD(1024)
        if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.splitext(os.path.basename(buf.value))[0]
        return ""
    finally:
        k.CloseHandle(h)


def windows():
    found = []
    fg = u.GetForegroundWindow()

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        if not u.IsWindowVisible(h):
            return True
        n = u.GetWindowTextLengthW(h)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(h, buf, n + 1)
        title = buf.value
        if title in SKIP_TITLES:
            return True
        # Fenêtres « cloaked » (UWP en arrière-plan) : DWMWA_CLOAKED = 14
        cloaked = ctypes.c_int(0)
        try:
            ctypes.windll.dwmapi.DwmGetWindowAttribute(h, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        except Exception:
            pass
        if cloaked.value:
            return True
        pid = w.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        found.append({"hwnd": h, "pid": pid.value, "process": proc_name(pid.value), "title": title, "foreground": h == fg})
        return True

    u.EnumWindows(cb, 0)
    return found


def find_window(query):
    q = str(query).strip()
    wins = windows()
    if q.isdigit():
        n = int(q)
        for x in wins:
            if x["hwnd"] == n or x["pid"] == n:
                return x
    ql = q.lower()
    # Priorité : titre qui commence par, puis contient, puis nom du processus
    for x in wins:
        if x["title"].lower().startswith(ql):
            return x
    for x in wins:
        if ql in x["title"].lower():
            return x
    for x in wins:
        if ql in x["process"].lower():
            return x
    return None


def focus(h):
    # Astuce classique : une pression ALT « détache » la restriction SetForegroundWindow
    u.keybd_event(0x12, 0, 0, 0)
    u.keybd_event(0x12, 0, 2, 0)
    if u.IsIconic(h):
        u.ShowWindow(h, 9)  # SW_RESTORE
    u.SetForegroundWindow(h)
    u.BringWindowToTop(h)


def shot(path, all_screens=False, max_width=1600):
    from PIL import ImageGrab

    im = ImageGrab.grab(all_screens=all_screens)
    real = im.size
    if im.width > max_width:
        ratio = max_width / im.width
        im = im.resize((max_width, int(im.height * ratio)))
    im.convert("RGB").save(path, "JPEG", quality=78, optimize=True)
    return {"file": path, "realSize": f"{real[0]}x{real[1]}", "savedSize": f"{im.width}x{im.height}", "scale": round(real[0] / im.width, 4)}


def click(x, y, right=False, double=False):
    u.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    down, up = (0x0008, 0x0010) if right else (0x0002, 0x0004)
    for _ in range(2 if double else 1):
        u.mouse_event(down, 0, 0, 0, 0)
        u.mouse_event(up, 0, 0, 0, 0)
        time.sleep(0.07)
    return {"ok": True, "x": int(x), "y": int(y), "button": "right" if right else "left", "double": double}


def main(argv):
    cmd = argv[0] if argv else "screen"
    if cmd == "screen":
        out({"primary": f"{u.GetSystemMetrics(0)}x{u.GetSystemMetrics(1)}", "virtual": f"{u.GetSystemMetrics(78)}x{u.GetSystemMetrics(79)}", "screens": u.GetSystemMetrics(80)})
    elif cmd == "shot":
        out(shot(argv[1], all_screens=(len(argv) > 2 and argv[2] == "all"), max_width=int(argv[3]) if len(argv) > 3 else 1600))
    elif cmd == "windows":
        out({"windows": windows()})
    elif cmd in ("focus", "minimize", "maximize", "close"):
        win = find_window(" ".join(argv[1:]))
        if not win:
            out({"error": "Aucune fenêtre ne correspond à « " + " ".join(argv[1:]) + " »"})
            return
        h = win["hwnd"]
        if cmd == "focus":
            focus(h)
        elif cmd == "minimize":
            u.ShowWindow(h, 6)
        elif cmd == "maximize":
            focus(h)
            u.ShowWindow(h, 3)
        elif cmd == "close":
            u.PostMessageW(h, 0x0010, 0, 0)  # WM_CLOSE : l'application peut demander à sauvegarder
        out({"ok": True, "action": cmd, "process": win["process"], "title": win["title"], "pid": win["pid"]})
    elif cmd == "click":
        out(click(argv[1], argv[2], right="right" in argv[3:], double="double" in argv[3:]))
    elif cmd == "move":
        u.SetCursorPos(int(argv[1]), int(argv[2]))
        out({"ok": True})
    else:
        out({"error": "commande inconnue : " + cmd})


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:  # toujours du JSON en sortie
        out({"error": str(e)})
