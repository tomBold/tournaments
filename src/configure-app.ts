import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Tournaments API')
      .setDescription('Create tournaments, ingest bets, and read live or final leaderboards. Amounts are in cents.')
      .setVersion('1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
