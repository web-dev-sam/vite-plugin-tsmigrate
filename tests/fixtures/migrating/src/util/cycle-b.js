import { stepA } from "./cycle-a.js";

export function stepB(app) {
  return app ? stepA(null) : null;
}
