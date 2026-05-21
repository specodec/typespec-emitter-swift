import { type EmitContext, emitFile, type Model, type Type, type Enum, type Union } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  type EnumInfo,
  type EnumMemberInfo,
  type FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toCamelCase,
  dottedPathToSnakeCase,
  dottedPathToPascalCase,
  checkAndReportReservedKeywords,
  safeFieldName,
  type UnionInfo,
  type UnionVariantInfo,
  isUnionType,
  isScalarVariant,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

let _tmpCounter = 0;
function nextTmp(): string {
  return `tmp${_tmpCounter++}`;
}

function typeToSwift(type: Type): string {
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return "String";
      case "boolean":
        return "Bool";
      case "int8":
        return "Int8";
      case "int16":
        return "Int16";
      case "int32":
      case "integer":
        return "Int32";
      case "int64":
        return "Int64";
      case "uint8":
        return "UInt8";
      case "uint16":
        return "UInt16";
      case "uint32":
        return "UInt32";
      case "uint64":
        return "UInt64";
      case "float32":
        return "Float";
      case "float64":
      case "float":
      case "decimal":
        return "Double";
      case "bytes":
        return "Data";
    }
  }
  if (type.kind === "Enum") return "String";
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type)!)}]`;
  if (isRecordType(type)) return `[String: ${typeToSwift(recordElementType(type)!)}]`;
  if (type.kind === "Model") return (type as Model).name || "Any";
  if (isUnionType(type)) return (type as Union).name || "Any";
  return "Any";
}

function defaultForSwiftType(type: Type, swiftType: string): string {
  switch (swiftType) {
    case "String":
      return `""`;
    case "Bool":
      return "false";
    case "Int8":
    case "Int16":
    case "Int32":
    case "Int64":
      return "0";
    case "UInt8":
    case "UInt16":
    case "UInt32":
    case "UInt64":
      return "0";
    case "Float":
    case "Double":
      return "0.0";
    case "Data":
      return "Data()";
  }
  if (swiftType.startsWith("[String:")) return "[:]";
  if (swiftType.startsWith("[")) return "[]";
  return `${swiftType}()`;
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    return `${w}.beginArray(${expr}.count); for item in ${expr} { ${w}.nextElement(); ${writeExpr("item", elem, w)} }; ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return `${w}.beginObject(${expr}.count); for (key, val) in ${expr} { ${w}.writeField(key); ${writeExpr("val", elem, w)} }; ${w}.endObject()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return `${w}.writeString(${expr})`;
      case "boolean":
        return `${w}.writeBool(${expr})`;
      case "int8":
        return `${w}.writeInt32(Int32(${expr}))`;
      case "int16":
        return `${w}.writeInt32(Int32(${expr}))`;
      case "int32":
      case "integer":
        return `${w}.writeInt32(${expr})`;
      case "int64":
        return `${w}.writeInt64(${expr})`;
      case "uint8":
        return `${w}.writeUint32(UInt32(${expr}))`;
      case "uint16":
        return `${w}.writeUint32(UInt32(${expr}))`;
      case "uint32":
        return `${w}.writeUint32(${expr})`;
      case "uint64":
        return `${w}.writeUint64(${expr})`;
      case "float32":
        return `${w}.writeFloat32(${expr})`;
      case "float64":
      case "float":
      case "decimal":
        return `${w}.writeFloat64(${expr})`;
      case "bytes":
        return `${w}.writeBytes(${expr})`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeString(${expr})`;
  if (isModelType(type)) return `write${(type as Model).name}(${w}, ${expr})`;
  if (isUnionType(type)) return `write${(type as Union).name}(${w}, ${expr})`;
  return `/* TODO: unknown type */`;
}

function readExpr(type: Type): string {
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return "try r.readString()";
      case "boolean":
        return "try r.readBool()";
      case "int8":
        return "Int8(try r.readInt32())";
      case "int16":
        return "Int16(try r.readInt32())";
      case "int32":
      case "integer":
        return "try r.readInt32()";
      case "int64":
        return "try r.readInt64()";
      case "uint8":
        return "UInt8(try r.readUint32())";
      case "uint16":
        return "UInt16(try r.readUint32())";
      case "uint32":
        return "try r.readUint32()";
      case "uint64":
        return "try r.readUint64()";
      case "float32":
        return "try r.readFloat32()";
      case "float64":
      case "float":
      case "decimal":
        return "try r.readFloat64()";
      case "bytes":
        return "try r.readBytes()";
    }
  }
  if (type.kind === "Enum") return "try r.readString()";
  if (type.kind === "Model" && (type as Model).name) {
    const modelName = (type as Model).name;
    return `try decode${modelName}(r)`;
  }
  if (isUnionType(type) && (type as Union).name) {
    const unionName = (type as Union).name;
    return `try decode${unionName}(r)`;
  }
  return "try r.readString()";
}

function generateFieldRead(f: { name: string; type: any; optional: boolean }): { stmts: string[]; value: string } {
  if (isArrayType(f.type)) {
    const elem = arrayElementType(f.type)!;
    const swiftElem = typeToSwift(elem);
    const tmp = nextTmp();
    const stmts: string[] = [];
    if (f.optional) {
      stmts.push(`var ${tmp}: [${swiftElem}]? = nil`);
      stmts.push(`if try r.isNull() { try r.readNull() } else {`);
      stmts.push(`    var _arr: [${swiftElem}] = []`);
      stmts.push(`    try r.beginArray()`);
      stmts.push(`    while try r.hasNextElement() { _arr.append(${readExpr(elem)}) }`);
      stmts.push(`    try r.endArray()`);
      stmts.push(`    ${tmp} = _arr`);
      stmts.push(`}`);
      return { stmts, value: tmp };
    } else {
      stmts.push(`var ${tmp}: [${swiftElem}] = []`);
      stmts.push(`try r.beginArray()`);
      stmts.push(`while try r.hasNextElement() { ${tmp}.append(${readExpr(elem)}) }`);
      stmts.push(`try r.endArray()`);
      return { stmts, value: tmp };
    }
  }
  if (isRecordType(f.type)) {
    const elem = recordElementType(f.type)!;
    const swiftElem = typeToSwift(elem);
    const tmp = nextTmp();
    const stmts: string[] = [];
    if (f.optional) {
      stmts.push(`var ${tmp}: [String: ${swiftElem}]? = nil`);
      stmts.push(`if try r.isNull() { try r.readNull() } else {`);
      stmts.push(`    var _dict: [String: ${swiftElem}] = [:]`);
      stmts.push(`    try r.beginObject()`);
      stmts.push(`    while try r.hasNextField() { _dict[try r.readFieldName()] = ${readExpr(elem)} }`);
      stmts.push(`    try r.endObject()`);
      stmts.push(`    ${tmp} = _dict`);
      stmts.push(`}`);
      return { stmts, value: tmp };
    } else {
      stmts.push(`var ${tmp}: [String: ${swiftElem}] = [:]`);
      stmts.push(`try r.beginObject()`);
      stmts.push(`while try r.hasNextField() { ${tmp}[try r.readFieldName()] = ${readExpr(elem)} }`);
      stmts.push(`try r.endObject()`);
      return { stmts, value: tmp };
    }
  }
  if (f.optional && ((f.type.kind === "Model" && (f.type as Model).name) || (isUnionType(f.type) && (f.type as Union).name))) {
    const swType = typeToSwift(f.type);
    const tmp = nextTmp();
    const stmts: string[] = [];
    stmts.push(`var ${tmp}: ${swType}? = nil`);
    stmts.push(`if try r.isNull() { try r.readNull() } else { ${tmp} = ${readExpr(f.type)} }`);
    return { stmts, value: tmp };
  }
  return { stmts: [], value: readExpr(f.type) };
}

function isSelfReferencing(model: Model): boolean {
  const name = model.name;
  for (const [, prop] of model.properties) {
    let t = prop.type;
    if (isArrayType(t)) t = arrayElementType(t)!;
    if (t.kind === "Model" && (t as Model).name === name) return true;
  }
  return false;
}

function generateEnumCode(e: EnumInfo): string {
  const lines: string[] = [];
  lines.push(`public enum ${e.name}: Int {`);
  for (const m of e.members) {
    lines.push(`    case ${m.name} = ${m.value}`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

function generateModelCode(m: Model): string {
  const name = m.name!;
  const fields = extractFields(m);
  const requiredFields = fields.filter((f) => !f.optional);
  const optionalFields = fields.filter((f) => f.optional);
  const useClass = isSelfReferencing(m);
  const swiftField = (f: FieldInfo) => safeFieldName("swift", toCamelCase(f.name));
  const lines: string[] = [];

  lines.push(`public ${useClass ? "final class" : "struct"} ${name} {`);
  for (const f of fields) {
    lines.push(`    public var ${swiftField(f)}: ${typeToSwift(f.type)}${f.optional ? "?" : ""}`);
  }
  const hasUnionField = fields.some((f) => !f.optional && isUnionType(f.type));
  if (fields.length > 0 && !hasUnionField) {
    lines.push(`    public init() {`);
    for (const f of fields) {
      lines.push(`        ${swiftField(f)} = ${f.optional ? "nil" : defaultForSwiftType(f.type, typeToSwift(f.type))}`);
    }
    lines.push(`    }`);
    const initParams = fields
      .map((f) => {
        const swType = typeToSwift(f.type);
        return f.optional ? `${swiftField(f)}: ${swType}? = nil` : `${swiftField(f)}: ${swType}`;
      })
      .join(", ");
    lines.push(`    public init(${initParams}) {`);
    lines.push(`        ${fields.map((f) => `self.${swiftField(f)} = ${swiftField(f)}`).join("; ")}`);
    lines.push(`    }`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`public func write${name}(_ w: any SpecWriter, _ obj: ${name}) {`);
  if (optionalFields.length > 0) {
    lines.push(`    var fieldCount = ${requiredFields.length}`);
    for (const f of optionalFields) lines.push(`    if obj.${swiftField(f)} != nil { fieldCount += 1 }`);
    lines.push(`    w.beginObject(fieldCount)`);
  } else {
    lines.push(`    w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(
        `    if let ${swiftField(f)} = obj.${swiftField(f)} { w.writeField("${f.name}"); ${writeExpr(`${swiftField(f)}`, f.type, "w")} }`,
      );
    } else {
      lines.push(`    w.writeField("${f.name}"); ${writeExpr(`obj.${swiftField(f)}`, f.type, "w")}`);
    }
  }
  lines.push(`    w.endObject()`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`public func decode${name}(_ r: any SpecReader) throws -> ${name} {`);
  for (const f of fields) {
    const sf = toCamelCase(f.name);
    const swType = typeToSwift(f.type);
    if (f.optional) {
      lines.push(`    var ${sf}: ${swType}? = nil`);
    } else if (isUnionType(f.type)) {
      lines.push(`    var ${sf}: ${swType} = .${swType}Undefined(.instance)`);
    } else {
      lines.push(`    var ${sf}: ${swType} = ${defaultForSwiftType(f.type, swType)}`);
    }
  }
  lines.push(`    try r.beginObject()`);
  lines.push(`    while try r.hasNextField() {`);
  lines.push(`        switch try r.readFieldName() {`);
  for (const f of fields) {
    const sf = toCamelCase(f.name);
    const result = generateFieldRead(f);
    if (result.stmts.length > 0) {
      lines.push(`        case "${f.name}":`);
      for (const stmt of result.stmts) {
        lines.push(`            ${stmt}`);
      }
      lines.push(`            ${sf} = ${result.value}`);
    } else {
      lines.push(`        case "${f.name}": ${sf} = ${result.value}`);
    }
  }
  lines.push(`        default: try r.skip()`);
  lines.push(`        }`);
  lines.push(`    }`);
  lines.push(`    try r.endObject()`);
  lines.push(`    return ${name}(${fields.map((f) => `${toCamelCase(f.name)}: ${toCamelCase(f.name)}`).join(", ")})`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`public let ${name}Codec = SpecCodec<${name}>(`);
  lines.push(`    encode: { w, obj in write${name}(w, obj) },`);
  lines.push(`    decode: { r throws in try decode${name}(r) }`);
  lines.push(`)`);
  lines.push(``);

  return lines.join("\n");
}

function generateUnionCode(u: UnionInfo, L: string[]): void {
  const name = u.name;
  L.push(`public enum ${name} {`);
  for (const v of u.variants) {
    const pascal = v.name.charAt(0).toUpperCase() + v.name.slice(1);
    L.push(`    case ${name}${pascal}(${typeToSwift(v.type)})`);
  }
  L.push(`    case ${name}Undefined(SpecUndefined)`);
  L.push(`}`);
  L.push(``);

  L.push(`public func write${name}(_ w: any SpecWriter, _ obj: ${name}) {`);
  L.push(`    w.beginObject(1)`);
  L.push(`    switch obj {`);
  for (const v of u.variants) {
    const pascal = v.name.charAt(0).toUpperCase() + v.name.slice(1);
    L.push(`    case .${name}${pascal}(let v): w.writeField("${v.name}"); ${writeExpr("v", v.type, "w")}`);
  }
    L.push(`    case .${name}Undefined: return  // cannot encode undefined variant`);
  L.push(`    }`);
  L.push(`    w.endObject()`);
  L.push(`}`);
  L.push(``);

  L.push(`public func decode${name}(_ r: any SpecReader) throws -> ${name} {`);
  L.push(`    try r.beginObject()`);
  L.push(`    guard try r.hasNextField() else { try r.endObject(); throw SCodecError(code: "unknownField", message: "empty union") }`);
  L.push(`    let field = try r.readFieldName()`);
  L.push(`    var result: ${name} = .${name}Undefined(.instance)`);
  L.push(`    switch field {`);
  for (const v of u.variants) {
    const pascal = v.name.charAt(0).toUpperCase() + v.name.slice(1);
    L.push(`    case "${v.name}": result = .${name}${pascal}(${readExpr(v.type)})`);
  }
  L.push(`    default: throw SCodecError(code: "unknownField", message: "unknown variant \\(field)")`);
  L.push(`    }`);
  L.push(`    while try r.hasNextField() { _ = try r.readFieldName(); try r.skip() }`);
  L.push(`    try r.endObject()`);
  L.push(`    return result`);
  L.push(`}`);
  L.push(``);

  L.push(`public let ${name}Codec = SpecCodec<${name}>(`);
  L.push(`    encode: { w, obj in write${name}(w, obj) },`);
  L.push(`    decode: { r throws in try decode${name}(r) }`);
  L.push(`)`);
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
    for (const e of svc.enums) lines.push(generateEnumCode(e));
    if (svc.enums.length > 0) lines.push("");
    for (const m of svc.models) {
      lines.push(generateModelCode(m));
    }
    for (const u of svc.unions) {
      generateUnionCode(u, lines);
    }
    // Swift uses PascalCase file names
    const fileName = `${dottedPathToPascalCase(svc.serviceName)}Types.swift`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
