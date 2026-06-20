"""Capture Quietfolio window screenshots for the README."""
from __future__ import annotations

import time
from pathlib import Path

import mss
import mss.tools
import pyautogui
import pygetwindow as gw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"


def find_window():
    candidates = [
        w for w in gw.getAllWindows()
        if w.title and ("Quietfolio" in w.title or w.title.strip() == "Quietfolio")
    ]
    if candidates:
        return candidates[0]
    for w in gw.getAllWindows():
        if w.title and "electron" in w.title.lower():
            return w
    return None


def capture(window, filename: str) -> None:
    if window.isMinimized:
        window.restore()
    window.activate()
    time.sleep(0.8)
    left = max(window.left, 0)
    top = max(window.top, 0)
    width = max(window.width, 400)
    height = max(window.height, 300)
    with mss.MSS() as sct:
        shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
        mss.tools.to_png(shot.rgb, shot.size, output=str(OUT / filename))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    time.sleep(2)
    window = find_window()
    if not window:
        raise SystemExit("Quietfolio window not found")

    print(f"Found window: {window.title!r} ({window.width}x{window.height})")
    window.activate()
    time.sleep(1)

    # Rail: Home is the second nav button under the logo.
    home_x = window.left + 36
    home_y = window.top + 108
    library_x = window.left + 36
    library_y = window.top + 156

    pyautogui.click(home_x, home_y)
    time.sleep(1.2)
    capture(window, "home.png")
    print("Saved home.png")

    pyautogui.click(library_x, library_y)
    time.sleep(1.2)
    capture(window, "library.png")
    print("Saved library.png")


if __name__ == "__main__":
    main()
