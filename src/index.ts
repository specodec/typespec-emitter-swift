import {
  EmitContext,
  emitFile,
  listServices,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
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

function scalarName(type: Type): string | null {
  if (type.kind !== "Scalar") return null;
  const s = type as Scalar;
  if (s.name) return s.name;
  if (s.baseScalar) return scalarName(s.baseScalar);
  return null;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  return (type as Model).indexer!.value;
}

function typeToSwift(type: Type): string {
  const name = scalarName(type);
  if (name) {
    switch (name) {
      case "string": return "String";
      case "boolean": return "Bool";
      case "int8": case "int16": case "int32": case "integer": return "Int32";
      case "int64": return "Int64";
      case "uint8": case "uint16": case "uint32": return "UInt32";
      case "uint64": return "UInt64";
      case "float32": return "Float";
      case "float64": case "float": case "decimal": return "Double";
      case "bytes": return "Data";
    }
  }
  if (isArrayType(type)) return `[${typeToSwift(arrayElementType(type))}]`;
  if (type.kind === "Model") return (type as Model).name || "Any";
  return "Any";
}

function defaultForSwiftType(swiftType: string): string {
  switch (swiftType) {
    case "String": return `""`;
    case "Bool": return "false";
    case "Int32": case "Int64": case "UInt32": case "UInt64": return "0";
    case "Float": case "Double": return "0";
    case "Data": return "Data()";
  }
  if (swiftType.startsWith("[")) return "[]";
  return "nil";
}

function writeExpr(type: Type, expr: string): string {
  const name = scalarName(type);
  if (name) {
    switch (name) {
      case "string": return `w.writeString(${expr})`;
      case "boolean": return `w.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer": return `w.writeInt32(Int32(${expr}))`;
      case "int64": return `w.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32": return `w.writeUint32(UInt32(${expr}))`;
      case "uint64": return `w.writeUint64(${expr})`;
      case "float32": return `w.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `w.writeFloat64(${expr})`;
      case "bytes": return `w.writeBytes(${expr})`;
    }
  }
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `w.beginArray(${expr}.count); for _e in ${expr} { w.nextElement(); ${writeExpr(elem, "_e")} }; w.endArray()`;
  }
  return `/* TODO: write model */`;
}

function readExpr(type: Type): string {
  const name = scalarName(type);
  if (name) {
    switch (name) {
      case "string": return "try r.readString()";
      case "boolean": return "try r.readBool()";
      case "int8": case "int16": case "int32": case "integer": return "try r.readInt32()";
      case "int64": return "try r.readInt64()";
      case "uint8": case "uint16": case "uint32": return "try r.readUint32()";
      case "uint64": return "try r.readUint64()";
      case "float32": return "try r.readFloat32()";
      case "float64": case "float": case "decimal": return "try r.readFloat64()";
      case "bytes": return "try r.readBytes()";
    }
  }
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const sw = typeToSwift(type);
    return `{ var _arr: ${sw} = []; try r.beginArray(); while try r.hasNextElement() { _arr.append(${readExpr(elem)}) }; try r.endArray(); return _arr }()`;
  }
  if (type.kind === "Model") {
    const modelName = (type as Model).name;
    return `try ${modelName}Codec.decode(r)`;
  }
  return "/* TODO: read */";
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function emitModel(m: Model): string {
  const name = m.name!;
  const fields = extractFields(m);
  const lines: string[] = [];

  lines.push(`public struct ${name} {`);
  for (const f of fields) {
    const swType = typeToSwift(f.type);
    lines.push(`    public var ${f.name}: ${swType}${f.optional ? "?" : ""}`);
  }
  if (fields.length > 0) {
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

  const optionalFields = fields.filter(f => f.optional);

  const jsonWriteLines: string[] = [];
  jsonWriteLines.push(`        let w = JsonWriter()`);
  jsonWriteLines.push(`        w.beginObject()`);
  for (const f of fields) {
    if (f.optional) {
      jsonWriteLines.push(`        if let _${f.name} = obj.${f.name} { w.writeField("${f.name}"); ${writeExpr(f.type, `_${f.name}`)} }`);
    } else {
      jsonWriteLines.push(`        w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${f.name}`)}`);
    }
  }
  jsonWriteLines.push(`        w.endObject()`);
  jsonWriteLines.push(`        return w.toBytes()`);

  const msgPackWriteLines: string[] = [];
  const requiredCount = fields.filter(f => !f.optional).length;
  if (optionalFields.length === 0) {
    msgPackWriteLines.push(`        let w = MsgPackWriter()`);
    msgPackWriteLines.push(`        w.beginObject(${requiredCount})`);
  } else {
    msgPackWriteLines.push(`        var _n = ${requiredCount}`);
    for (const f of optionalFields) {
      msgPackWriteLines.push(`        if obj.${f.name} != nil { _n += 1 }`);
    }
    msgPackWriteLines.push(`        let w = MsgPackWriter()`);
    msgPackWriteLines.push(`        w.beginObject(_n)`);
  }
  for (const f of fields) {
    if (f.optional) {
      msgPackWriteLines.push(`        if let _${f.name} = obj.${f.name} { w.writeField("${f.name}"); ${writeExpr(f.type, `_${f.name}`)} }`);
    } else {
      msgPackWriteLines.push(`        w.writeField("${f.name}"); ${writeExpr(f.type, `obj.${f.name}`)}`);
    }
  }
  msgPackWriteLines.push(`        w.endObject()`);
  msgPackWriteLines.push(`        return w.toBytes()`);

  const decodeLines: string[] = [];
  for (const f of fields) {
    const swType = typeToSwift(f.type);
    if (f.optional) {
      decodeLines.push(`        var _${f.name}: ${swType}? = nil`);
    } else {
      decodeLines.push(`        var _${f.name}: ${swType} = ${defaultForSwiftType(swType)}`);
    }
  }
  decodeLines.push(`        try r.beginObject()`);
  decodeLines.push(`        while try r.hasNextField() {`);
  decodeLines.push(`            switch try r.readFieldName() {`);
  for (const f of fields) {
    decodeLines.push(`            case "${f.name}": _${f.name} = ${readExpr(f.type)}`);
  }
  decodeLines.push(`            default: try r.skip()`);
  decodeLines.push(`            }`);
  decodeLines.push(`        }`);
  decodeLines.push(`        try r.endObject()`);
  const ctorArgs = fields.map(f => `${f.name}: _${f.name}`).join(", ");
  decodeLines.push(`        return ${name}(${ctorArgs})`);

  lines.push(`public let ${name}Codec = SpecCodec<${name}>(`);
  lines.push(`    encodeJson: { obj in`);
  for (const l of jsonWriteLines) lines.push(`    ${l}`);
  lines.push(`    },`);
  lines.push(`    encodeMsgPack: { obj in`);
  for (const l of msgPackWriteLines) lines.push(`    ${l}`);
  lines.push(`    },`);
  lines.push(`    decode: { r in`);
  for (const l of decodeLines) lines.push(`    ${l}`);
  lines.push(`    }`);
  lines.push(`)`);
  lines.push(``);

  return lines.join("\n");
}

function collectServices(program: Program): { serviceName: string; models: Model[] }[] {
  const services = listServices(program);
  const result: { serviceName: string; models: Model[] }[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const models: Model[] = [];
      const seen = new Set<string>();
      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name) && !isArrayType(m)) {
            models.push(m);
            seen.add(m.name);
          }
        },
      });
      result.push({ serviceName: iface.name, models });
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
  const snake = (s: string) => s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());

  for (const svc of collectServices(program)) {
    if (svc.models.length === 0) continue;
    const lines: string[] = [];
    lines.push("import Foundation");
    lines.push("import Specodec");
    lines.push("");
    for (const m of svc.models) {
      lines.push(emitModel(m));
    }
    const fileName = `${snake(svc.serviceName)}_types.swift`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
