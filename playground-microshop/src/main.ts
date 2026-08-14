// Playground entry: pull in the Micro Shop's own bundle barrel from the
// vendored submodule so the tsmigrate crawl fans out across the real shop
// module graph — every shop web component (shop-header/-catalog/-sidebar,
// product-card, cart-container and its Articles/Checkout/Pay/Thanks panels)
// plus the shared helpers, resolved to source (no library build required).
import "../microcomponents/demo/shop/bundle-entry.ts";
