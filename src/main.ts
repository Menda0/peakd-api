import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule);
  const corsOrigins = parseCorsOrigins();
  app.enableCors({
    origin: corsOrigins?.length ? corsOrigins : true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
  });
  const port = process.env.PORT ?? '3001';
  await app.listen(Number(port));
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
