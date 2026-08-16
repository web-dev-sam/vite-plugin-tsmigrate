import { stepB } from "./cycle-b.js";

export function stepA(app) {
  return stepB(app);
}
