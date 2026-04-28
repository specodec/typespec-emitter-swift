import {
  EmitContext,
  emitFile,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Program,
  Type,
  Scalar,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "string";
  return false;
}

function isIntType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "int8" || n === "int16" || n === "int32" || n === "int64" || n === "uint8" || n === "uint16" || n === "uint32" || n === "uint64" || n === "integer";
  }
  return false;
}

function isFloatType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const n = (type as Scalar).name;
    return n === "float" || n === "float32" || n === "float64" || n === "decimal";
  }
  return false;
}

function isBoolType(type: Type): boolean {
  if (type.kind === "Scalar") return (type as Scalar).name === "boolean";
  return false;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToSwift(type: Type): string {
  if (isStringType(type)) return "String";
  if (isIntType(type)) return "Int64";
  if (isFloatType(type)) return "Double";
  if (isBoolType(type)) return "Bool";
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type))}]`;
  if (type.kind === "Model") return type.name || "Any";
  return "Any";
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function collectModels(program: Program): Model[] {
  const models: Model[] = [];
  const seen = new Set<string>();

  function walkNs(ns: Namespace) {
    navigateTypesInNamespace(ns, {
      model: (m: Model) => {
        if (m.name && !seen.has(m.name)) {
          models.push(m);
          seen.add(m.name);
        }
      },
    });
    for (const [, child] of ns.namespaces) {
      walkNs(child);
    }
  }

  const globalNs = program.getGlobalNamespaceType();
  walkNs(globalNs);
  return models;
}

function emitSwiftTypes(program: Program, models: Model[], outputDir: string): Promise<void> {
  const lines: string[] = [];
  lines.push("import Foundation");
  lines.push("");

  for (const m of models) {
    if (!m.name) continue;
    const fields = extractFields(m);
    lines.push(`public struct ${m.name}: Codable, Sendable {`);
    for (const f of fields) {
      lines.push(`    public var ${f.name}: ${typeToSwift(f.type)}${f.optional ? "?" : ""}`);
    }
    if (fields.length > 0) {
      lines.push(`    public init(${fields.map(f => `${f.name}: ${typeToSwift(f.type)}${f.optional ? "? = nil" : ""}`).join(", ")}) {`);
      for (const f of fields) {
        lines.push(`        self.${f.name} = ${f.name}`);
      }
      lines.push("    }");
    }
    lines.push("}");
    lines.push("");
  }

  return emitFile(program, { path: `${outputDir}/Types.swift`, content: lines.join("\n") });
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;

  const models = collectModels(program);
  await emitSwiftTypes(program, models, outputDir);
}
