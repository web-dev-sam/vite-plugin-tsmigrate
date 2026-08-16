import { stepA } from "./cycle-a.js";

export function bootLegacy(app) {
  return stepA(app);
}
