import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

function parseCorsOrigins(): string[] | undefined {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw) {
    return undefined;
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const corsOrigins = parseCorsOrigins();
  app.enableCors({
    origin: corsOrigins?.length ? corsOrigins : true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'stripe-signature'],
  });

  app.use(
    json({
      verify: (req, _res, buf) => {
        const url = req.url ?? '';
        if (url.startsWith('/billing/stripe/webhook')) {
          (req as { rawBody?: Buffer }).rawBody = buf;
        }
      },
    }),
  );

  const port = process.env.PORT ?? '3001';
  await app.listen(Number(port));
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
