"""Regression tests: the Bluetooth password never reaches the logs."""

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest
from bleak.backends.device import BLEDevice

from custom_components.ld2410.api.const import (
    CMD_BT_GET_PERMISSION,
    CMD_BT_SET_PWD,
    CMD_REBOOT,
)
from custom_components.ld2410.api.devices.ld2410 import LD2410, _password_to_words

PASSWORD = "S3cr#t"
PASSWORD_HEX = "".join(_password_to_words(PASSWORD))


async def _send_logged(raw_command: str, caplog: pytest.LogCaptureFixture) -> str:
    device = LD2410(
        device=BLEDevice(address="AA:BB", name="test", details=None, rssi=-60),
        password=PASSWORD,
    )
    device._client = MagicMock(write_gatt_char=AsyncMock())
    device._read_char = device._write_char = MagicMock()
    with caplog.at_level(logging.DEBUG):
        await device._execute_command_locked(
            raw_command, device._modify_command(raw_command), False
        )
    device._client.write_gatt_char.assert_awaited_once()
    return caplog.text


@pytest.mark.parametrize("command_word", [CMD_BT_GET_PERMISSION, CMD_BT_SET_PWD])
async def test_password_commands_are_redacted(
    command_word: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Login and set-password commands log only the command word."""
    text = await _send_logged(command_word + PASSWORD_HEX, caplog)

    assert f"{command_word}******" in text
    assert PASSWORD not in text
    assert PASSWORD_HEX.lower() not in text.lower()


async def test_other_commands_are_logged_in_full(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Commands without secrets keep their full payload for debugging."""
    assert f"Sending command: {CMD_REBOOT}" in await _send_logged(CMD_REBOOT, caplog)
