export type OscArgument =
  | { type: 's'; value: string }
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 'b'; value: Uint8Array };

export interface OscMessage {
  address: string;
  args: OscArgument[];
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function encodeString(value: string): Uint8Array {
  const text = new TextEncoder().encode(value);
  const result = new Uint8Array(text.length + 1 + pad4(text.length + 1));
  result.set(text, 0);
  return result;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function encodeOscMessage(
  address: string,
  args: OscArgument[] = []
): Uint8Array {
  const parts: Uint8Array[] = [encodeString(address)];
  parts.push(encodeString(',' + args.map(arg => arg.type).join('')));

  for (const arg of args) {
    if (arg.type === 's') {
      parts.push(encodeString(arg.value));
      continue;
    }

    if (arg.type === 'i' || arg.type === 'f') {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      if (arg.type === 'i') view.setInt32(0, arg.value, false);
      else view.setFloat32(0, arg.value, false);
      parts.push(new Uint8Array(buffer));
      continue;
    }

    const length = new ArrayBuffer(4);
    new DataView(length).setInt32(0, arg.value.byteLength, false);
    const padding = new Uint8Array(pad4(arg.value.byteLength));
    parts.push(new Uint8Array(length), arg.value, padding);
  }

  return concat(parts);
}

function readOscString(
  bytes: Uint8Array,
  start: number
): { value: string; next: number } {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end >= bytes.length) throw new Error('osc_unterminated_string');

  const value = new TextDecoder().decode(bytes.slice(start, end));
  const rawLength = end - start + 1;
  return {
    value,
    next: start + rawLength + pad4(rawLength)
  };
}

export function decodeOscMessage(bytes: Uint8Array): OscMessage {
  const addressResult = readOscString(bytes, 0);
  const typeResult = readOscString(bytes, addressResult.next);

  if (!typeResult.value.startsWith(',')) {
    throw new Error('osc_invalid_type_tag');
  }

  let offset = typeResult.next;
  const args: OscArgument[] = [];

  for (const type of typeResult.value.slice(1)) {
    if (type === 's') {
      const item = readOscString(bytes, offset);
      args.push({ type: 's', value: item.value });
      offset = item.next;
      continue;
    }

    if (type === 'i' || type === 'f') {
      if (offset + 4 > bytes.length) throw new Error('osc_truncated_number');
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        4
      );
      args.push({
        type,
        value:
          type === 'i'
            ? view.getInt32(0, false)
            : view.getFloat32(0, false)
      } as OscArgument);
      offset += 4;
      continue;
    }

    if (type === 'b') {
      if (offset + 4 > bytes.length) throw new Error('osc_truncated_blob');
      const length = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        4
      ).getInt32(0, false);
      offset += 4;
      if (length < 0 || offset + length > bytes.length) {
        throw new Error('osc_invalid_blob_length');
      }
      args.push({
        type: 'b',
        value: bytes.slice(offset, offset + length)
      });
      offset += length + pad4(length);
      continue;
    }

    throw new Error(`osc_unsupported_type:${type}`);
  }

  return { address: addressResult.value, args };
}

export function decodeX32MeterBlob(blob: Uint8Array): number[] {
  if (blob.byteLength < 4) throw new Error('x32_meter_blob_too_short');
  const view = new DataView(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength
  );
  const count = view.getUint32(0, true);
  const expected = 4 + count * 4;
  if (expected > blob.byteLength) throw new Error('x32_meter_blob_truncated');

  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(view.getFloat32(4 + index * 4, true));
  }
  return values;
}
