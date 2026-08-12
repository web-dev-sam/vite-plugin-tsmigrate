/// <reference types="vite/client" />

declare module "virtual:tsmigrate" {
  export const greeting: string;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
