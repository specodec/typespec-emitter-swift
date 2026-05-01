import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
  Diagnostic,
} from "@typespec/compiler";
import {
  checkReservedKeyword,
  formatReservedError,
} from "@specodec/typespec-specodec-core";

export type EmitterOptions = {
  "emitter-output-dir": string;
  "ignore-reserved-keywords"?: boolean;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

function scalarName(type: Type): string | null {
  if (type.kind !== "Scalar") return null;
  const s = type as Scalar;
  if (s.name) return s.name;
  if (s.baseScalar) return scalarName(s.baseScalar);
  return null;
}

function isArrayType(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "integer";
}

function isRecordType(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "string";
}

function isModelType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).name && !isArrayType(type) && !isRecordType(type);
}

function arrayElementType(type: Type): Type {
  return (type as Model).indexer!.value;
}

function recordElementType(type: Type): Type {
  return (type as Model).indexer!.value;
}

function typeToSwift(type: Type): string {
  const name = scalarName(type);
  if (name) {
    switch (name) {
      case "string": return "String";
      case "boolean": return "Bool";
      case "int8": return "Int8";
      case "int16": return "Int16";
      case "int32": case "integer": return "Int32";
      case "int64": return "Int64";
      case "uint8": return "UInt8";
      case "uint16": return "UInt16";
      case "uint32": return "UInt32";
      case "uint64": return "UInt64";
      case "float32": return "Float";
      case "float64": case "float": case "decimal": return "Double";
      case "bytes": return "Data";
    }
  }
  if (type.kind === "Enum") return "String";
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type))}]`;
  if (isRecordType(type)) return `[String: ${typeToSwift(recordElementType(type))}]`;
  if (type.kind === "Model") return (type as Model).name || "Any";
  return "Any";
}

function defaultForSwiftType(swiftType: string): string {
  switch (swiftType) {
    case "String": return `""`;
    case "Bool": return "false";
    case "Int8": case "Int16": case "Int32": case "Int64": return "0";
    case "UInt8": case "UInt16": case "UInt32": case "UInt64": return "0";
    case "Float": case "Double": return "0.0";
    case "Data": return "Data()";
  }
  // For model types, use default initializer
  if (swiftType.startsWith("[String:")) return "[:]";
  if (swiftType.startsWith("[")) return "[]";
  return `${swiftType}()`;
}

// Single format-agnostic write expression using SpecWriter
function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `${w}.beginArray(${expr}.count); for _e in ${expr} { ${w}.nextElement(); ${writeExpr("_e", elem, w)} }; ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `${w}.beginObject(${expr}.count); for (_k, _v) in ${expr} { ${w}.writeField(_k); ${writeExpr("_v", elem, w)} }; ${w}.endObject()`;
  }
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": return `${w}.writeInt32(Int32(${expr}))`;
      case "int16": return `${w}.writeInt32(Int32(${expr}))`;
      case "int32": case "integer": return `${w}.writeInt32(${expr})`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": return `${w}.writeUint32(UInt32(${expr}))`;
      case "uint16": return `${w}.writeUint32(UInt32(${expr}))`;
      case "uint32": return `${w}.writeUint32(${expr})`;
      case "uint64": return `${w}.writeUint64(${expr})`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeEnum(${expr})`;
  if (isModelType(type)) {
    return `_write${(type as Model).name}(${w}, ${expr})`;
  }
  return `/* TODO: unknown type */`;
}

function readExpr(type: Type, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const swiftElem = typeToSwift(elem);
    return `try { () throws -> [${swiftElem}] in var _a: [${swiftElem}] = []; try r.beginArray(); while try r.hasNextElement() { _a.append(${readExpr(elem)}) }; try r.endArray(); return _a }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    const swiftElem = typeToSwift(elem);
    return `try { () throws -> [String: ${swiftElem}] in var _m: [String: ${swiftElem}] = [:]; try r.beginObject(); while try r.hasNextField() { let _k = try r.readFieldName(); _m[_k] = ${readExpr(elem)} }; try r.endObject(); return _m }()`;
  }
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return "try r.readString()";
      case "boolean": return "try r.readBool()";
      case "int8": return "Int8(try r.readInt32())";
      case "int16": return "Int16(try r.readInt32())";
      case "int32": case "integer": return "try r.readInt32()";
      case "int64": return "try r.readInt64()";
      case "uint8": return "UInt8(try r.readUint32())";
      case "uint16": return "UInt16(try r.readUint32())";
      case "uint32": return "try r.readUint32()";
      case "uint64": return "try r.readUint64()";
      case "float32": return "try r.readFloat32()";
      case "float64": case "float": case "decimal": return "try r.readFloat64()";
      case "bytes": return "try r.readBytes()";
    }
  }
  if (type.kind === "Enum") return "try r.readEnum()";
  if (type.kind === "Model") {
    const modelName = (type as Model).name;
    if (!modelName) return "try r.readString()";
    if (optional) {
      return `try { () throws -> ${modelName}? in if try r.isNull() { try r.readNull(); return nil }; return try _decode${modelName}(r) }()`;
    }
    return `try _decode${modelName}(r)`;
  }
  return "try r.readString()";
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function isSelfReferencing(model: Model): boolean {
  const name = model.name;
  for (const [, prop] of model.properties) {
    let t = prop.type;
    if (isArrayType(t)) t = arrayElementType(t);
    if (t.kind === "Model" && (t as Model).name === name) return true;
  }
  return false;
}

function emitModel(m: Model): string {
  const name = m.name!;
  const fields = extractFields(m);
  const lines: string[] = [];
  const requiredFields = fields.filter(f => !f.optional);
  const optionalFields = fields.filter(f => f.optional);
  const useClass = isSelfReferencing(m);

  lines.push(`public ${useClass ? 'final class' : 'struct'} ${name} {`);
  for (const f of fields) {
    const swType = typeToSwift(f.type);
    lines.push(`    public var ${f.name}: ${swType}${f.optional ? "?" : ""}`);
  }
  // Add default init() for model types to use in decode functions
  if (fields.length > 0) {
    lines.push(`    public init() {`);
    for (const f of fields) {
      const defaultVal = f.optional ? "nil" : defaultForSwiftType(typeToSwift(f.type));
      lines.push(`        ${f.name} = ${defaultVal}`);
    }
    lines.push(`    }`);
    // Also add parameterized init
    const initParams = fields.map(f => {
      const swType = typeToSwift(f.type);
      return f.optional ? `${f.name}: ${swType}? = nil` : `${f.name}: ${swType}`;
    }).join(", ");
    lines.push(`    public init(${initParams}) {`);
    const assigns = fields.map(f => `self.${f.name} = ${f.name}`).join("; ");
    lines.push(`        ${assigns}`);
    lines.push(`    }`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`private func _write${name}(_ w: any SpecWriter, _ obj: ${name}) {`);
  if (optionalFields.length > 0) {
    lines.push(`    var _n = ${requiredFields.length}`);
    for (const f of optionalFields) {
      lines.push(`    if obj.${f.name} != nil { _n += 1 }`);
    }
    lines.push(`    w.beginObject(_n)`);
  } else {
    lines.push(`    w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(`    if let _${f.name} = obj.${f.name} { w.writeField("${f.name}"); ${writeExpr(`_${f.name}`, f.type, "w")} }`);
    } else {
      lines.push(`    w.writeField("${f.name}"); ${writeExpr(`obj.${f.name}`, f.type, "w")}`);
    }
  }
  lines.push(`    w.endObject()`);
  lines.push(`}`);
  lines.push(``);

  // Standalone decode function (avoids circular reference in static let codec)
  lines.push(`private func _decode${name}(_ r: any SpecReader) throws -> ${name} {`);
  for (const f of fields) {
    const swType = typeToSwift(f.type);
    if (f.optional) {
      lines.push(`    var _${f.name}: ${swType}? = nil`);
    } else {
      lines.push(`    var _${f.name}: ${swType} = ${defaultForSwiftType(swType)}`);
    }
  }
  lines.push(`    try r.beginObject()`);
  lines.push(`    while try r.hasNextField() {`);
  lines.push(`        switch try r.readFieldName() {`);
  for (const f of fields) {
    lines.push(`        case "${f.name}": _${f.name} = ${readExpr(f.type, f.optional)}`);
  }
  lines.push(`        default: try r.skip()`);
  lines.push(`        }`);
  lines.push(`    }`);
  lines.push(`    try r.endObject()`);
  const ctorArgs = fields.map(f => `${f.name}: _${f.name}`).join(", ");
  lines.push(`    return ${name}(${ctorArgs})`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`public enum ${name}Codec {`);
  lines.push(`    public static let codec = SpecCodec<${name}>(`);
  lines.push(`        encode: { w, obj in _write${name}(w, obj) },`);
  lines.push(`        decode: { r throws in try _decode${name}(r) }`);
  lines.push(`    )`);
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

function isStdLibNamespace(ns: Namespace): boolean {
  const fullName = getNamespaceFullName(ns);
  return fullName === "TypeSpec" || fullName.startsWith("TypeSpec.");
}

function collectServices(program: Program): { serviceName: string; models: Model[] }[] {
  const services = listServices(program);
  const result: { serviceName: string; models: Model[] }[] = [];

  function collectFromNs(ns: Namespace, iface?: Interface) {
    if (isStdLibNamespace(ns)) return;
    const models: Model[] = [];
    const seen = new Set<string>();
    navigateTypesInNamespace(ns, {
      model: (m: Model) => {
        if (m.name && !seen.has(m.name) && !isArrayType(m)) {
          const modelNs = m.namespace;
          if (modelNs && !isStdLibNamespace(modelNs)) {
            models.push(m);
            seen.add(m.name);
          }
        }
      },
    });
    if (models.length > 0) {
      result.push({ serviceName: iface?.name || ns.name || "TestService", models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const snake = (s: string) => s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
  const services = collectServices(program);

  const reservedFieldErrors: Diagnostic[] = [];
  for (const svc of services) {
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const [fieldName, prop] of m.properties) {
        const reservedIn = checkReservedKeyword(fieldName);
        if (reservedIn.length > 0) {
          const message = formatReservedError(fieldName, m.name, reservedIn);
          const diag: Diagnostic = {
            severity: "error",
            code: "reserved-keyword",
            message,
            target: prop,
          };
          reservedFieldErrors.push(diag);
        }
      }
    }
  }

  if (reservedFieldErrors.length > 0 && !ignoreReservedKeywords) {
    program.reportDiagnostics(reservedFieldErrors);
    return;
  }

  if (reservedFieldErrors.length > 0 && ignoreReservedKeywords) {
    for (const diag of reservedFieldErrors) {
      console.warn(`Warning: ${diag.message}`);
    }
  }

  for (const svc of services) {
    if (svc.models.length === 0) continue;
    const lines: string[] = [];
    lines.push("import Foundation");
    lines.push("import Specodec");
    lines.push("");
    for (const m of svc.models) {
      lines.push(emitModel(m));
    }
    const fileName = `${svc.serviceName}Types.swift`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
