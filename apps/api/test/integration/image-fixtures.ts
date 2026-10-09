const u16 = (n: number): Buffer => Buffer.from([n >> 8, n & 0xff]);

/** JPEG structurellement valide avec un bloc EXIF contenant une position GPS. */
export function jpegWithGps(pixels = 'pixels'): Buffer {
  const exif = Buffer.from('Exif\0\0GPS-LATITUDE-48.8566');
  const jfif = Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), u16(jfif.length + 2), jfif,
    Buffer.from([0xff, 0xe1]), u16(exif.length + 2), exif,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from(pixels), Buffer.from([0xff, 0xd9]),
  ]);
}

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
};

/** PNG structurellement valide avec un bloc texte « Location ». */
export function pngWithText(pixels = 'pixels'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from('Location\0Paris-GPS')),
    chunk('IDAT', Buffer.from(pixels)),
    chunk('IEND'),
  ]);
}

export function webp(): Buffer {
  const body = Buffer.from('WEBPVP8 \x04\0\0\0abcd');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
}
