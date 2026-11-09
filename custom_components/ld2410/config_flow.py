"""Config flow."""

from __future__ import annotations

import logging
import re
from typing import Any

from .api import Advertisement, LD2410, OperationError, parse_advertisement_data
from bleak_retry_connector import BLEAK_RETRY_EXCEPTIONS
import voluptuous as vol

from homeassistant.components.bluetooth import (
    BluetoothServiceInfoBleak,
    async_discovered_service_info,
)
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_ADDRESS, CONF_SENSOR_TYPE, CONF_PASSWORD
from homeassistant.core import callback
from homeassistant.data_entry_flow import AbortFlow
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from .const import (
    CONF_NEW_PASSWORD,
    CONF_RETRY_COUNT,
    CONNECTABLE_MODEL_TYPES,
    DEFAULT_RETRY_COUNT,
    DOMAIN,
    SUPPORTED_MODEL_TYPES,
)

_LOGGER = logging.getLogger(__name__)

# The device stores exactly six printable ASCII characters.
PASSWORD_PATTERN = re.compile(r"[ -~]{6}")


def format_unique_id(address: str) -> str:
    """Format the unique ID for a device."""
    return address.replace(":", "").lower()


def short_address(address: str) -> str:
    """Convert a Bluetooth address to a short address."""
    results = address.replace("-", ":").split(":")
    return f"{results[-2].upper()}{results[-1].upper()}"[-4:]


def name_from_discovery(discovery: Advertisement) -> str:
    """Get the name from a discovery."""
    return f"{discovery.data['modelFriendlyName']}_{short_address(discovery.address)}"


class LD2410ConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> LD2410OptionsFlowHandler:
        """Get the options flow for this handler."""
        return LD2410OptionsFlowHandler()

    def __init__(self) -> None:
        """Initialize the config flow."""
        self._discovered_adv: Advertisement | None = None
        self._discovered_advs: dict[str, Advertisement] = {}

    async def async_step_bluetooth(
        self, discovery_info: BluetoothServiceInfoBleak
    ) -> ConfigFlowResult:
        """Handle the bluetooth discovery step."""
        _LOGGER.debug("Discovered bluetooth device: %s", discovery_info.as_dict())
        await self.async_set_unique_id(format_unique_id(discovery_info.address))
        self._abort_if_unique_id_configured()
        parsed = parse_advertisement_data(
            discovery_info.device, discovery_info.advertisement
        )
        if not parsed or parsed.data.get("modelName") not in SUPPORTED_MODEL_TYPES:
            return self.async_abort(reason="not_supported")
        model_name = parsed.data.get("modelName")
        if not discovery_info.connectable and model_name in CONNECTABLE_MODEL_TYPES:
            # Source is not connectable but the model is connectable
            return self.async_abort(reason="not_supported")
        self._discovered_adv = parsed
        self.context["title_placeholders"] = {"name": name_from_discovery(parsed)}
        return await self.async_step_password()

    async def async_step_password(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the password step."""
        assert self._discovered_adv is not None
        errors: dict[str, str] = {}
        if user_input is not None:
            device = LD2410(
                device=self._discovered_adv.device,
                password=user_input[CONF_PASSWORD],
            )
            device._should_reconnect = False
            try:
                await device.cmd_send_bluetooth_password()
            except OperationError:
                errors["base"] = "wrong_password"
            except BLEAK_RETRY_EXCEPTIONS:
                errors["base"] = "cannot_connect"
            finally:
                await device.async_disconnect()
            if not errors:
                return await self._async_create_entry_from_discovery(user_input)

        return self.async_show_form(
            step_id="password",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_PASSWORD,
                        default=user_input.get(CONF_PASSWORD, "HiLink")
                        if user_input
                        else "HiLink",
                    ): str
                }
            ),
            description_placeholders={
                "name": name_from_discovery(self._discovered_adv)
            },
            errors=errors or None,
        )

    async def _async_create_entry_from_discovery(
        self, user_input: dict[str, Any]
    ) -> ConfigFlowResult:
        """Create an entry from a discovery."""
        assert self._discovered_adv is not None
        discovery = self._discovered_adv
        name = name_from_discovery(discovery)
        model_name = discovery.data["modelName"]
        return self.async_create_entry(
            title=name,
            data={
                **user_input,
                CONF_ADDRESS: discovery.address,
                CONF_SENSOR_TYPE: str(SUPPORTED_MODEL_TYPES[model_name]),
            },
        )

    async def async_step_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm a single device."""
        assert self._discovered_adv is not None
        if user_input is not None:
            return await self._async_create_entry_from_discovery(user_input)

        self._set_confirm_only()
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({}),
            description_placeholders={
                "name": name_from_discovery(self._discovered_adv)
            },
        )

    @callback
    def _async_discover_devices(self) -> None:
        current_addresses = self._async_current_ids(include_ignore=False)
        for connectable in (True, False):
            for discovery_info in async_discovered_service_info(self.hass, connectable):
                address = discovery_info.address
                if (
                    format_unique_id(address) in current_addresses
                    or address in self._discovered_advs
                ):
                    continue
                parsed = parse_advertisement_data(
                    discovery_info.device, discovery_info.advertisement
                )
                if not parsed:
                    continue
                model_name = parsed.data.get("modelName")
                if discovery_info.connectable and model_name in CONNECTABLE_MODEL_TYPES:
                    self._discovered_advs[address] = parsed

        if not self._discovered_advs:
            raise AbortFlow("no_devices_found")

    async def _async_set_device(self, discovery: Advertisement) -> None:
        """Set the device to work with."""
        self._discovered_adv = discovery
        address = discovery.address
        await self.async_set_unique_id(
            format_unique_id(address), raise_on_progress=False
        )
        self._abort_if_unique_id_configured()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the user step to pick discovered device."""
        errors: dict[str, str] = {}
        device_adv: Advertisement | None = None
        if user_input is not None:
            device_adv = self._discovered_advs[user_input[CONF_ADDRESS]]
            await self._async_set_device(device_adv)
            return await self.async_step_password()

        self._async_discover_devices()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ADDRESS): vol.In(
                        {
                            address: name_from_discovery(parsed)
                            for address, parsed in self._discovered_advs.items()
                        }
                    ),
                }
            ),
            errors=errors,
        )


class LD2410OptionsFlowHandler(OptionsFlow):
    """Handle options."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage options; optionally change the device's Bluetooth password."""
        errors: dict[str, str] = {}
        if user_input is not None:
            new_password = user_input.pop(CONF_NEW_PASSWORD, "")
            if new_password:
                errors = await self._async_change_password(new_password)
            if not errors:
                # Merge, so options stored elsewhere (saved sensitivities) survive.
                return self.async_create_entry(
                    title="", data={**self.config_entry.options, **user_input}
                )

        options: dict[vol.Optional, Any] = {
            vol.Optional(
                CONF_RETRY_COUNT,
                default=self.config_entry.options.get(
                    CONF_RETRY_COUNT, DEFAULT_RETRY_COUNT
                ),
            ): vol.All(int, vol.Range(min=0)),
            vol.Optional(CONF_NEW_PASSWORD): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
        }
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema(options), errors=errors or None
        )

    async def _async_change_password(self, password: str) -> dict[str, str]:
        """Set a new password on the device, save it and reboot the device."""
        if not PASSWORD_PATTERN.fullmatch(password):
            return {CONF_NEW_PASSWORD: "invalid_password"}
        if self.config_entry.state is not ConfigEntryState.LOADED:
            return {"base": "not_loaded"}
        device = self.config_entry.runtime_data.device
        try:
            await device.cmd_set_bluetooth_password(password)
        except (OperationError, *BLEAK_RETRY_EXCEPTIONS) as err:
            # A later step may fail after the device accepted the password;
            # then the new one must be saved or we would lock ourselves out.
            if not device.password_is(password):
                _LOGGER.warning("%s: Failed to change password: %s", device.name, err)
                return {"base": "change_failed"}
        self.hass.config_entries.async_update_entry(
            self.config_entry, data={**self.config_entry.data, CONF_PASSWORD: password}
        )
        try:
            await device.cmd_reboot()
        except (OperationError, *BLEAK_RETRY_EXCEPTIONS) as err:
            _LOGGER.warning(
                "%s: Password changed, but reboot failed; reboot it manually: %s",
                device.name,
                err,
            )
        return {}
