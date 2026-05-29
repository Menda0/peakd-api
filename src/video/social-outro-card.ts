import sharp from 'sharp';

/** Builds a full-frame outro card PNG (logo + tagline) without ffmpeg drawtext. */
export async function buildSocialOutroCardPng(options: {
  width: number;
  height: number;
  logoPath: string;
  outputPath: string;
}): Promise<string> {
  const { width, height, logoPath, outputPath } = options;
  const logoWidth = Math.round(width * 0.55);
  const fontSize = Math.max(24, Math.round(height / 28));
  const textPaddingY = Math.round(fontSize * 0.35);
  const textBlockHeight = Math.round(fontSize * 1.35) + textPaddingY * 2;

  const textSvg = Buffer.from(
    `<svg width="${width}" height="${textBlockHeight}" viewBox="0 0 ${width} ${textBlockHeight}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width / 2}" y="${textBlockHeight / 2}" text-anchor="middle" dominant-baseline="middle"
        fill="#ffffff" font-size="${fontSize}" font-family="Arial, Helvetica, sans-serif">
        more at peakd.surf
      </text>
    </svg>`,
  );

  const logoMeta = await sharp(logoPath).metadata();
  const logoHeight = Math.round(
    logoWidth * ((logoMeta.height ?? 1) / (logoMeta.width ?? 1)),
  );
  const logoBuf = await sharp(logoPath)
    .resize(logoWidth, logoHeight, { fit: 'inside' })
    .png()
    .toBuffer();

  const textMeta = await sharp(textSvg).metadata();
  const textBuf = await sharp(textSvg).png().toBuffer();
  const textHeight = textMeta.height ?? textBlockHeight;

  const logoTop = Math.round(height * 0.35 - logoHeight / 2);
  const textGap = Math.max(16, Math.round(height * 0.02));
  const minTextTop = logoTop + logoHeight + textGap;
  const maxTextTop = height - textHeight - Math.round(height * 0.04);
  const textTop = Math.max(0, Math.min(minTextTop, maxTextTop));

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 13, g: 17, b: 23, alpha: 1 },
    },
  })
    .composite([
      {
        input: logoBuf,
        top: Math.max(0, logoTop),
        left: Math.round((width - logoWidth) / 2),
      },
      {
        input: textBuf,
        top: textTop,
        left: 0,
      },
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}
