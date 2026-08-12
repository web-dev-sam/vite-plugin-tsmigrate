import { RESOLVED_VIRTUAL_MODULE_ID, VIRTUAL_MODULE_ID } from "./constants.ts";
import type { ResolvedOptions } from "./options.ts";

export function resolveVirtualId(id: string): string | undefined {
  if (id === VIRTUAL_MODULE_ID) {
    return RESOLVED_VIRTUAL_MODULE_ID;
  }
  return undefined;
}

export function loadVirtualModule(id: string, options: ResolvedOptions): string | undefined {
  if (id === RESOLVED_VIRTUAL_MODULE_ID) {
    return `export const greeting = ${JSON.stringify(options.greeting)};\n`;
  }
  return undefined;
}
