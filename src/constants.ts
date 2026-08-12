export const PLUGIN_NAME = "vite-plugin-tsmigrate";

/** Import specifier consumers use to load the generated module. */
export const VIRTUAL_MODULE_ID = "virtual:tsmigrate";

// Resolved ids of virtual modules are prefixed with NUL so that other plugins
// (and Vite internals) leave them untouched.
// https://vite.dev/guide/api-plugin#virtual-modules-convention
export const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

export const DEFAULT_TOOL_PORT = 7357;
