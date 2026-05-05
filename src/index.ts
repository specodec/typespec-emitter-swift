import {
  EmitContext,
  emitFile,
  Model,
  Type,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  toPascalCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToSwift(type: Type): string {
  const n = scalarName(type);
  if (n) {
    switch (n) {
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
  if (swiftType.startsWith("[String:")) return "[:]";
  if (swiftType.startsWith("[")) return "[]";
  return `${swiftType}()`;
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `${w}.beginArray(${expr}.count); for item in ${expr} { ${w}.nextElement(); ${writeExpr("item", elem, w)} }; ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `${w}.beginObject(${expr}.count); for (key, val) in ${expr} { ${w}.writeField(key); ${writeExpr("val", elem, w)} }; ${w}.endObject()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
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
  if (isModelType(type)) return `write${(type as Model).name}(${w}, ${expr})`;
  return `/* TODO: unknown type */`;
}

function readExpr(type: Type, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const swiftElem = typeToSwift(elem);
    return `try { () throws -> [${swiftElem}] in var arr: [${swiftElem}] = []; try r.beginArray(); while try r.hasNextElement() { arr.append(${readExpr(elem)}) }; try r.endArray(); return arr }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    const swiftElem = typeToSwift(elem);
    return `try { () throws -> [String: ${swiftElem}] in var dict: [String: ${swiftElem}] = [:]; try r.beginObject(); while try r.hasNextField() { let key = try r.readFieldName(); dict[key] = ${readExpr(elem)} }; try r.endObject(); return dict }()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
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
  if (type.kind === "Model" && (type as Model).name) {
    const modelName = (type as Model).name;
    if (optional) return `try { () throws -> ${modelName}? in if try r.isNull() { try r.readNull(); return nil }; return try decode${modelName}(r) }()`;
    return `try decode${modelName}(r)`;
  }
  return "try r.readString()";
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
  const requiredFields = fields.filter(f => !f.optional);
  const optionalFields = fields.filter(f => f.optional);
  const useClass = isSelfReferencing(m);
  const lines: string[] = [];

  lines.push(`public ${useClass ? "final class" : "struct"} ${name} {`);
  for (const f of fields) {
    lines.push(`    public var ${f.name}: ${typeToSwift(f.type)}${f.optional ? "?" : ""}`);
  }
  if (fields.length > 0) {
    lines.push(`    public init() {`);
    for (const f of fields) {
      lines.push(`        ${f.name} = ${f.optional ? "nil" : defaultForSwiftType(typeToSwift(f.type))}`);
    }
    lines.push(`    }`);
    const initParams = fields.map(f => {
      const swType = typeToSwift(f.type);
      return f.optional ? `${f.name}: ${swType}? = nil` : `${f.name}: ${swType}`;
    }).join(", ");
    lines.push(`    public init(${initParams}) {`);
    lines.push(`        ${fields.map(f => `self.${f.name} = ${f.name}`).join("; ")}`);
    lines.push(`    }`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`private func write${name}(_ w: any SpecWriter, _ obj: ${name}) {`);
  if (optionalFields.length > 0) {
    lines.push(`    var fieldCount = ${requiredFields.length}`);
    for (const f of optionalFields) lines.push(`    if obj.${f.name} != nil { fieldCount += 1 }`);
    lines.push(`    w.beginObject(fieldCount)`);
  } else {
    lines.push(`    w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(`    if let ${f.name} = obj.${f.name} { w.writeField("${f.name}"); ${writeExpr(`${f.name}`, f.type, "w")} }`);
    } else {
      lines.push(`    w.writeField("${f.name}"); ${writeExpr(`obj.${f.name}`, f.type, "w")}`);
    }
  }
  lines.push(`    w.endObject()`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`private func decode${name}(_ r: any SpecReader) throws -> ${name} {`);
  for (const f of fields) {
    const swType = typeToSwift(f.type);
    if (f.optional) {
      lines.push(`    var ${f.name}: ${swType}? = nil`);
    } else {
      lines.push(`    var ${f.name}: ${swType} = ${defaultForSwiftType(swType)}`);
    }
  }
  lines.push(`    try r.beginObject()`);
  lines.push(`    while try r.hasNextField() {`);
  lines.push(`        switch try r.readFieldName() {`);
  for (const f of fields) {
    lines.push(`        case "${f.name}": ${f.name} = ${readExpr(f.type, f.optional)}`);
  }
  lines.push(`        default: try r.skip()`);
  lines.push(`        }`);
  lines.push(`    }`);
  lines.push(`    try r.endObject()`);
  lines.push(`    return ${name}(${fields.map(f => `${f.name}: ${f.name}`).join(", ")})`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`public let ${name}Codec = SpecCodec<${name}>(`);
  lines.push(`    encode: { w, obj in write${name}(w, obj) },`);
  lines.push(`    decode: { r throws in try decode${name}(r) }`);
  lines.push(`)`);
  lines.push(``);

  return lines.join("\n");
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    const lines: string[] = [];
    lines.push("// Generated by @specodec/typespec-emitter-swift. DO NOT EDIT.");
    lines.push("import Foundation");
    lines.push("import Specodec");
    lines.push("");
    for (const m of svc.models) {
      lines.push(emitModel(m));
    }
    // Swift uses PascalCase file names
    const fileName = `${toPascalCase(toSnakeCase(svc.serviceName))}Types.swift`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
