"""Sidebar panel for tuning LD2410 radars from the Home Assistant UI."""

from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PANEL_URL_PATH = DOMAIN
PANEL_ELEMENT = "ld2410-tuning-panel"
STATIC_URL = f"/{DOMAIN}_static"
FRONTEND_DIR = Path(__file__).parent / "frontend"
MODULE_FILE = "ld2410-tuning-card.js"


def _module_hash() -> str:
    """Return a short content hash, so browsers reload the module after updates."""
    return hashlib.sha256((FRONTEND_DIR / MODULE_FILE).read_bytes()).hexdigest()[:8]


async def async_register_panel(hass: HomeAssistant) -> None:
    """Serve the frontend module and add the admin-only sidebar panel."""
    if "frontend" not in hass.config.components:
        return
    version = await hass.async_add_executor_job(_module_hash)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
    )
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title="雷達調校",
        sidebar_icon="mdi:radar",
        module_url=f"{STATIC_URL}/{MODULE_FILE}?v={version}",
        require_admin=True,
    )
