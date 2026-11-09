"""Test the tuning sidebar panel."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.components.http import HomeAssistantHTTP
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.ld2410.const import DOMAIN
from custom_components.ld2410.panel import MODULE_FILE, PANEL_ELEMENT, STATIC_URL


def _patch_static_paths():
    return patch.object(HomeAssistantHTTP, "async_register_static_paths", AsyncMock())


async def test_panel_skipped_without_frontend(hass: HomeAssistant) -> None:
    """Without the frontend (e.g. headless setups) nothing is registered."""
    with _patch_static_paths() as register:
        assert await async_setup_component(hass, DOMAIN, {})

    register.assert_not_awaited()
    assert DOMAIN not in hass.data.get(DATA_PANELS, {})


async def test_panel_registered(hass: HomeAssistant) -> None:
    """The panel is served from the integration and visible to admins only."""
    hass.config.components.add("frontend")
    with _patch_static_paths() as register:
        assert await async_setup_component(hass, DOMAIN, {})

    (static,) = register.await_args.args[0]
    assert static.url_path == STATIC_URL
    assert (Path(static.path) / MODULE_FILE).is_file()

    panel = hass.data[DATA_PANELS][DOMAIN]
    assert panel.require_admin
    assert panel.sidebar_icon == "mdi:radar"
    custom = panel.config["_panel_custom"]
    assert custom["name"] == PANEL_ELEMENT
    assert custom["module_url"].startswith(f"{STATIC_URL}/{MODULE_FILE}?v=")
