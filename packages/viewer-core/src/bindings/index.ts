// Customisable mouse and keyboard bindings (docs/BINDINGS_DESIGN.md), shared
// by the desktop app and the web viewer. Each surface supplies its command
// table (its keyboard preset); this module is the engine: input specs for any
// key / mouse button / wheel, override layering, conflicts and swap, click vs
// drag, capture, and the versioned JSON used for storage and import / export.

export * from "./inputs";
export * from "./map";
export * from "./mouse";
export * from "./gesture";
export * from "./storage";
export * from "./live";
export * from "./dom";
