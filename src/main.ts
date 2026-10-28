import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  configureApp(app);
  const port = Number(app.get(ConfigService).get('PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
