export { transpile, collectDataDecls, formatDiagnostic } from "./transpiler.js";
export type { Diagnostic, TranspileResult, TranspileOptions } from "./transpiler.js";
export { Registry } from "./registry.js";
export type { CtorInfo, DataDecl, Pattern } from "./registry.js";
export { checkMatch } from "./exhaustive.js";
export { emitFast, checkAndEmit, loadCompilerOptions, DEFAULT_COMPILER_OPTIONS } from "./emit.js";
export type { Generated, EmitResult, WriteFile } from "./emit.js";
